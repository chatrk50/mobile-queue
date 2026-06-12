import { db, getSetting, setSetting } from './db.js';
import { pushQueue, pushText } from './line.js';
import { hashPin, verifyPin } from './auth.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;

/** Append to the immutable sale_events audit trail — DEFERRED off the request path. These rows
 *  are pure audit (never read for reports/correctness), but writing them synchronously inside the
 *  order/pay transactions added a remote round-trip (to the Turso primary) to every cashier action.
 *  We queue them and flush on the next tick, so the till's response returns immediately. Best-effort:
 *  a logging failure (or a crash before flush) must never affect the actual sale. */
const _saleEventQueue = [];
let _saleEventScheduled = false;
function flushSaleEvents() {
  _saleEventScheduled = false;
  if (!_saleEventQueue.length) return;
  const batch = _saleEventQueue.splice(0, _saleEventQueue.length);
  try {
    const ins = db.prepare('INSERT INTO sale_events (branch_id, ticket_id, order_id, type, amount, actor, meta) VALUES (?,?,?,?,?,?,?)');
    for (const e of batch) ins.run(e.branchId, e.ticketId, e.orderId, e.type, e.amount, e.actor, e.meta ? JSON.stringify(e.meta) : null);
  } catch { /* audit is best-effort */ }
}
function logSaleEvent({ branchId = null, ticketId = null, orderId = null, type, amount = 0, actor = null, meta = null }) {
  _saleEventQueue.push({ branchId, ticketId, orderId, type, amount, actor, meta });
  if (!_saleEventScheduled) { _saleEventScheduled = true; setImmediate(flushSaleEvents); }
}
// Flush any queued audit rows on shutdown (best-effort) so a clean restart doesn't drop them.
for (const sig of ['SIGTERM', 'SIGINT', 'beforeExit']) { try { process.on(sig, flushSaleEvents); } catch { /* ignore */ } }

// LIFF link so the customer can re-open their queue anytime (sent as a button
// on the LINE card, so the raw URL stays hidden behind a label).
const LIFF_ID = process.env.LIFF_ID || '';
const queueLink = (zoneId) =>
  LIFF_ID ? `https://liff.line.me/${LIFF_ID}?zone=${zoneId}` : null;

export function getZone(zoneId) {
  return db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
}

/** A customer's still-active ticket in a zone, so re-opening the LIFF resumes it
 *  even if the browser/app was closed (looked up by their LINE user id). */
export function findActiveTicket(zoneId, lineUserId) {
  if (!lineUserId) return null;
  return db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND line_user_id = ? AND status IN ('pending','waiting','called')
     ORDER BY id DESC LIMIT 1`
  ).get(zoneId, lineUserId);
}

/** How many waiting groups are ahead of this ticket in its zone. */
export function aheadCount(ticket) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM tickets
     WHERE zone_id = ? AND status = 'waiting' AND number < ?`
  ).get(ticket.zone_id, ticket.number);
  return row.c;
}

/** Issue a new ticket in a zone. Returns the created ticket row (or throws). */
export function issueTicket({ storeId, zoneId, partySize = 1, lineUserId = null, customerName = null }) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error('zone_not_found');
  if (!zone.is_open) throw new Error('zone_closed');

  // No duplicate numbers per customer: if they already hold an active ticket in
  // this zone, return it instead of issuing a new one (and skip the extra push).
  if (lineUserId) {
    const existing = findActiveTicket(zoneId, lineUserId);
    if (existing) return { ticket: existing, ahead: aheadCount(existing) };
  }

  const tx = db.transaction(() => {
    // Re-read the counter inside the transaction so numbers are never reused.
    const cur = db.prepare('SELECT last_number, prefix FROM zones WHERE id = ?').get(zoneId);
    const next = cur.last_number + 1;
    db.prepare('UPDATE zones SET last_number = ? WHERE id = ?').run(next, zoneId);
    const info = db.prepare(
      `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(storeId, zoneId, next, code(cur.prefix, next), partySize, lineUserId, customerName);
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
  });

  const ticket = tx();
  const ahead = aheadCount(ticket);

  // Confirmation push (fire and forget)
  pushQueue(lineUserId,
    `🎫 รับคิวเรียบร้อย\n` +
    `หมายเลขคิวของคุณ: ${ticket.code}\n` +
    `คิวรอก่อนหน้า: ${ahead}\n` +
    `เราจะแจ้งเตือนทาง LINE เมื่อใกล้ถึงคิวของคุณค่ะ`,
    queueLink(zoneId), 'ดูคิวของฉัน');

  return { ticket, ahead };
}

/**
 * Call the next waiting ticket in a zone (lowest number).
 * After calling, evaluate "coming up soon" notifications for the new front of line.
 */
export function callNext(zoneId, threshold) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error('zone_not_found');

  const next = db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND status = 'waiting'
     ORDER BY number ASC LIMIT 1`
  ).get(zoneId);
  if (!next) return { called: null };

  db.prepare(
    `UPDATE tickets SET status='called', called_at=datetime('now'), called_count=called_count+1 WHERE id=?`
  ).run(next.id);
  db.prepare('UPDATE zones SET last_called = ? WHERE id = ?').run(next.number, zoneId);

  pushQueue(next.line_user_id,
    `🔔 ถึงคิวของคุณแล้ว!\n` +
    `หมายเลข: ${next.code}\n` +
    `กรุณามาที่เคาน์เตอร์ค่ะ`,
    queueLink(zoneId), 'ดูคิวของฉัน');

  evaluateSoonNotifications(zoneId, threshold);
  return { called: next };
}

/** Mark a called ticket served, or skip / cancel any ticket. */
export function setStatus(ticketId, status, threshold) {
  const allowed = ['served', 'skipped', 'cancelled', 'no_show'];
  if (!allowed.includes(status)) throw new Error('bad_status');
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  // Can't serve an order until payment is CONFIRMED (a customer "I've paid" claim
  // is not enough — the cashier must verify and mark it paid).
  if (status === 'served') {
    const o = orderForTicket(ticketId);
    if (o && o.payment_status !== 'paid') throw new Error('order_unpaid');
  }
  db.prepare(`UPDATE tickets SET status=?, closed_at=datetime('now') WHERE id=?`).run(status, ticketId);
  // Notify the customer on LINE when their order is handed over (served).
  if (status === 'served' && t.line_user_id) {
    pushQueue(t.line_user_id,
      `✅ รับเครื่องดื่มเรียบร้อย\n` +
      `หมายเลข: ${t.code}\n` +
      `We look forward to welcoming you back 😊`,
      queueLink(t.zone_id), 'ให้คะแนนร้าน');
  }
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
}

/**
 * Send a one-time "coming up soon" push to any waiting ticket that is now within
 * `threshold` groups of the front and hasn't been notified yet.
 */
export function evaluateSoonNotifications(zoneId, threshold) {
  const waiting = db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND status='waiting'
     ORDER BY number ASC`
  ).all(zoneId);

  waiting.forEach((t, idx) => {
    const ahead = idx; // position in the ordered waiting list
    if (ahead <= threshold && !t.notified_soon && t.line_user_id) {
      db.prepare('UPDATE tickets SET notified_soon = 1 WHERE id = ?').run(t.id);
      pushQueue(t.line_user_id,
        `⏰ ใกล้ถึงคิวของคุณแล้ว!\n` +
        `หมายเลข: ${t.code}\n` +
        `คิวรอก่อนหน้า: ${ahead}\n` +
        `กรุณากลับมาที่ร้านค่ะ`,
        queueLink(zoneId), 'ดูคิวของฉัน');
    }
  });
}

/** Customer rating (1..5) for a served ticket. */
export function setRating(ticketId, stars) {
  const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
  const t = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  db.prepare('UPDATE tickets SET rating = ? WHERE id = ?').run(s, ticketId);
  return { ok: true, rating: s };
}

// ---------- Financial settings (for the P&L in the report + Excel export) ----------
// Defaults come from env (durable on Render) then fall back to sensible stall figures;
// runtime edits are stored in the settings table (reset on redeploy like the rest of the DB).
// Defaults reflect YO-DEE's real costs (THB). Editable in the cashier Costs panel.
//   Packaging/cup = Cup 1.65 + Bear-dome lid 0.362 + Straw 0.3185 + Carry bag 0.285 = 2.6155
//   Rent/mo  = spot 8000/10mo (800) + 1800/wk (×4.333 ≈ 7800) + cart 2500 = 11,100
//   Wages/mo = labor1 420/wk (×4.333 ≈ 1820) + labor2 450/day ×26 = 11,700 -> 13,520
//   Utilities/mo = (electricity 80 + ice 120)/day ×26 = 5,200
//   Ingredients: deferred (set to 0% until the recipe costing is ready).
const FIN_KEYS = {
  ingredientPct: ['FIN_INGREDIENT_PCT', 0],       // ingredient cost as a share of revenue (TBD)
  packagingPerCup: ['FIN_PACKAGING_PER_CUP', 2.6155], // cup+lid+straw+bag per drink
  daysPerMonth: ['FIN_DAYS_PER_MONTH', 26],       // selling days/month (to prorate fixed costs)
  rent: ['FIN_RENT', 11100],
  wages: ['FIN_WAGES', 13520],
  utilities: ['FIN_UTILITIES', 5200],
  supplies: ['FIN_SUPPLIES', 0],
  marketing: ['FIN_MARKETING', 0],
  targetRevenue: ['FIN_TARGET_REVENUE', 0],       // monthly target; 0 = no target/variance
};
// Per-branch costs are namespaced fin_<branchId>_<key>; a branch value falls back to
// the global fin_<key>, then env, then the default. branchId null = global settings.
export function getFinanceSettings(branchId = null) {
  const out = {};
  for (const [key, [envKey, def]] of Object.entries(FIN_KEYS)) {
    const branchVal = branchId ? getSetting('fin_' + branchId + '_' + key, null) : null;
    const stored = branchVal != null ? branchVal : getSetting('fin_' + key, null);
    const envVal = process.env[envKey];
    const val = stored != null ? stored : (envVal != null ? envVal : def);
    out[key] = Number(val);
    if (!Number.isFinite(out[key])) out[key] = Number(def);
  }
  return out;
}
export function setFinanceSettings(patch = {}, branchId = null) {
  const prefix = branchId ? 'fin_' + branchId + '_' : 'fin_';
  for (const key of Object.keys(FIN_KEYS)) {
    if (patch[key] != null && patch[key] !== '') {
      const n = Math.max(0, Number(patch[key]));
      if (Number.isFinite(n)) setSetting(prefix + key, n);
    }
  }
  return getFinanceSettings(branchId);
}

/** Customer satisfaction (star distribution) + repeat-buyer stats (returning LINE customers). */
export function customerInsights() {
  const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let total = 0, sum = 0;
  for (const r of db.prepare('SELECT rating, COUNT(*) n FROM tickets WHERE rating IS NOT NULL GROUP BY rating').all()) {
    if (stars[r.rating] != null) { stars[r.rating] = r.n; total += r.n; sum += r.rating * r.n; }
  }
  const c = db.prepare('SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN order_count>=2 THEN 1 ELSE 0 END),0) repeat FROM customers').get();
  const top = db.prepare('SELECT name, order_count, last_order_at FROM customers WHERE order_count>=2 ORDER BY order_count DESC, last_order_at DESC LIMIT 10').all();
  return {
    satisfaction: { avg: total ? Math.round((sum / total) * 10) / 10 : null, total, stars },
    customers: { total: c.total || 0, repeat: c.repeat || 0, repeatPct: c.total ? Math.round((c.repeat / c.total) * 100) : 0, top },
  };
}
/** Daily report: cups sold, no-shows, avg wait, avg rating + per-zone, since the last reset. */
export function dailyReport(branchId = null) {
  const B = [branchId, branchId];   // for "(? IS NULL OR <branch col>=?)" guards
  const perZone = db.prepare(
    `SELECT z.id, z.name, z.prefix, z.last_number AS issued,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served')  AS served,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show') AS no_shows
     FROM zones z WHERE (? IS NULL OR z.store_id=?) ORDER BY z.id`
  ).all(...B);
  const cupsSold = perZone.reduce((s, z) => s + z.served, 0);
  const issued = perZone.reduce((s, z) => s + z.issued, 0);
  const noShows = perZone.reduce((s, z) => s + z.no_shows, 0);
  const wait = db.prepare(
    `SELECT AVG((julianday(called_at)-julianday(created_at))*86400) AS s
     FROM tickets WHERE called_at IS NOT NULL AND (? IS NULL OR store_id=?)`
  ).get(...B);
  const rating = db.prepare(
    `SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM tickets WHERE rating IS NOT NULL AND (? IS NULL OR store_id=?)`
  ).get(...B);
  // Item sales tagged drink/topping via the menu (so we can split the P&L and count cups).
  const itemSales = db.prepare(
    `SELECT oi.name,
            COALESCE(mi.category,'drink') AS category,
            SUM(oi.qty) AS qty,
            SUM(oi.qty*oi.price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.name = oi.name
     WHERE o.payment_status = 'paid' AND (? IS NULL OR o.branch_id=?)   -- SALES = paid only (pay-first); optional branch
     GROUP BY oi.name ORDER BY revenue DESC`
  ).all(...B);
  const grossSales = itemSales.reduce((s, i) => s + (i.revenue || 0), 0);
  itemSales.forEach((i) => { i.pct = grossSales ? i.revenue / grossSales : 0; });
  const drinkSales = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.revenue, 0);
  const toppingSales = grossSales - drinkSales;
  const cups = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.qty, 0);
  // Bill discounts on non-void orders reduce NET sales. revenue = gross − discounts
  // (defaults to gross since discounts are 0 until used — no behavior change).
  const discounts = db.prepare(`SELECT COALESCE(SUM(o.discount),0) AS d FROM orders o WHERE o.payment_status = 'paid' AND (? IS NULL OR o.branch_id=?)`).get(...B).d || 0;
  const revenue = Math.round((grossSales - discounts) * 100) / 100;

  // Cancelled / refunded / wasted orders — all excluded from sales above, reported separately.
  const vAgg = db.prepare(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.total),0) AS amount
     FROM orders o WHERE o.payment_status='void' AND (? IS NULL OR o.branch_id=?)`
  ).get(...B);
  const vCups = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(mi.category,'drink')!='topping' THEN oi.qty ELSE 0 END),0) AS cups
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     LEFT JOIN menu_items mi ON mi.name=oi.name
     WHERE o.payment_status='void' AND (? IS NULL OR o.branch_id=?)`
  ).get(...B);
  // Break the voids down by kind so the report shows: cancelled (neutral, no money),
  // refunded (money returned), waste (made-but-binned → a COST with no revenue).
  const vByKind = db.prepare(
    `SELECT COALESCE(o.void_kind,'void') AS kind, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.total),0) AS amount,
            COALESCE(SUM((SELECT COALESCE(SUM(CASE WHEN COALESCE(mi.category,'drink')!='topping' THEN oi.qty ELSE 0 END),0)
                          FROM order_items oi LEFT JOIN menu_items mi ON mi.name=oi.name WHERE oi.order_id=o.id)),0) AS cups
     FROM orders o WHERE o.payment_status='void' AND (? IS NULL OR o.branch_id=?)
     GROUP BY COALESCE(o.void_kind,'void')`
  ).all(...B);
  const byKind = { void:{orders:0,amount:0,cups:0}, refund:{orders:0,amount:0,cups:0}, waste:{orders:0,amount:0,cups:0} };
  for (const r of vByKind) byKind[r.kind] = { orders: r.orders, amount: r.amount, cups: r.cups };
  const voided = { orders: vAgg.orders, amount: vAgg.amount, cups: vCups.cups,
    cancelled: byKind.void, refunded: byKind.refund, waste: byKind.waste };

  // P&L from the financial settings (today's sales vs prorated daily fixed costs).
  const f = getFinanceSettings(branchId);
  const ingredient = f.ingredientPct * revenue;
  const packaging = f.packagingPerCup * cups;
  const cogs = ingredient + packaging;
  const grossProfit = revenue - cogs;
  // Waste = product made then discarded: its ingredient+packaging is spent but earns nothing.
  // A real cost with no revenue → it reduces net profit (separate from sold-goods COGS).
  const wasteCost = Math.round((byKind.waste.amount * f.ingredientPct + byKind.waste.cups * f.packagingPerCup) * 100) / 100;
  voided.waste.cost = wasteCost;
  const monthlyOpex = f.rent + f.wages + f.utilities + f.supplies + f.marketing;
  const dailyOpex = f.daysPerMonth > 0 ? monthlyOpex / f.daysPerMonth : monthlyOpex;
  const netProfit = grossProfit - dailyOpex - wasteCost;
  // Break-even: how many cups/day cover the prorated fixed costs, using the menu's
  // average drink price (so it's meaningful even before the first sale of the day).
  const refAvg = db.prepare("SELECT AVG(price) AS a FROM menu_items WHERE category='drink' AND active=1").get().a || 0;
  const contribPerCup = refAvg * (1 - f.ingredientPct) - f.packagingPerCup;
  const breakEvenCups = contribPerCup > 0 ? Math.ceil(dailyOpex / contribPerCup) : null;
  const targetDaily = f.targetRevenue > 0 && f.daysPerMonth > 0 ? f.targetRevenue / f.daysPerMonth : null;
  const pnl = {
    drinkSales, toppingSales, cups,
    ingredient, packaging, cogs, wasteCost,
    grossProfit, grossMargin: revenue ? grossProfit / revenue : 0,
    opexDaily: dailyOpex, opexMonthly: monthlyOpex,
    opexLines: { rent: f.rent, wages: f.wages, utilities: f.utilities, supplies: f.supplies, marketing: f.marketing },
    netProfit, netMargin: revenue ? netProfit / revenue : 0,
    avgPerCup: cups ? drinkSales / cups : 0,
    breakEvenCups, contribPerCup, refAvgPrice: refAvg,
    targetDaily, revenueVariance: targetDaily != null ? revenue - targetDaily : null,
  };
  return {
    cupsSold, issued, noShows, revenue, grossSales, discounts,
    avgWaitMin: wait.s != null ? Math.round((wait.s / 60) * 10) / 10 : null,
    avgRating: rating.avg != null ? Math.round(rating.avg * 10) / 10 : null,
    ratingCount: rating.n,
    itemSales, perZone, pnl, settings: f, voided,
  };
}

/** Order history (since the last daily reset): completed/cancelled tickets with their
 *  order detail, so the cashier can re-check after a customer leaves or a mistake. */
export function orderHistory(limit = 100) {
  const rows = db.prepare(
    `SELECT id, code, status, customer_name, closed_at
     FROM tickets WHERE status IN ('served','no_show','cancelled','skipped')
     ORDER BY COALESCE(closed_at, created_at) DESC, id DESC LIMIT ?`
  ).all(Math.max(1, Math.min(500, Number(limit) || 100)));
  return rows.map((t) => {
    const o = orderForTicket(t.id);
    const hasSlip = !!db.prepare('SELECT 1 FROM slips s JOIN orders o2 ON o2.id=s.order_id WHERE o2.ticket_id=? LIMIT 1').get(t.id);
    return {
      id: t.id, code: t.code, status: t.status, customer_name: t.customer_name,
      closed_at: t.closed_at,
      order_total: o ? o.total : null,
      payment_status: o ? o.payment_status : null,
      refund_requested: o ? (o.refund_requested || 0) : 0,
      refund_note: o ? (o.refund_note || null) : null,
      has_slip: hasSlip,
      lines: o ? o.lines : [],
    };
  });
}

/** Archive today's sales totals into sales_history (idempotent per date). Run at the
 *  daily reset (and callable on demand) so daily/monthly sell history accrues. */
export function archiveTodaySales() {
  const rep = dailyReport();
  if ((rep.issued || 0) === 0 && (rep.revenue || 0) === 0) return null; // nothing to save
  db.prepare(
    `INSERT OR REPLACE INTO sales_history
       (date, cups, revenue, gross, net, void_orders, void_cups, void_amount, issued, served, no_shows)
     VALUES (date('now','+7 hours'), ?,?,?,?,?,?,?,?,?,?)`
  ).run(rep.pnl.cups || 0, rep.revenue || 0, rep.pnl.grossProfit || 0, rep.pnl.netProfit || 0,
        rep.voided.orders || 0, rep.voided.cups || 0, rep.voided.amount || 0,
        rep.issued || 0, rep.cupsSold || 0, rep.noShows || 0);
  return rep;
}

/** Daily/monthly sell report from the archive. */
export function salesHistory() {
  const daily = db.prepare('SELECT * FROM sales_history ORDER BY date DESC LIMIT 90').all();
  const monthly = db.prepare(
    `SELECT substr(date,1,7) AS month,
            SUM(cups) AS cups, SUM(revenue) AS revenue, SUM(net) AS net,
            SUM(void_cups) AS void_cups, SUM(void_amount) AS void_amount, COUNT(*) AS days
     FROM sales_history GROUP BY month ORDER BY month DESC LIMIT 12`
  ).all();
  return { daily, monthly };
}

// ---------- Detailed read-only reports (transaction log / payment / void-refund /
// addon / hourly). All scoped to a BKK date (default today) + optional branch. ----------
export function detailedReports({ date = null, branchId = null } = {}) {
  const D = date;                  // null => today (BKK)
  const b = [branchId, branchId];  // for the "(? IS NULL OR o.branch_id = ?)" guard
  const DAY = "COALESCE(?, date('now','+7 hours'))";
  const BR = "(? IS NULL OR o.branch_id = ?)";

  const transactions = db.prepare(
    `SELECT t.code, t.status AS ticket_status, o.id AS order_id, o.created_at, o.paid_at, o.total, o.discount,
            o.payment_status, o.payment_method, o.void_kind,
            ps.name AS paid_by, cs.name AS created_by,
            (SELECT GROUP_CONCAT(oi.qty || 'x ' || oi.name, ', ') FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
       JOIN tickets t ON t.id = o.ticket_id
       LEFT JOIN staff ps ON ps.id = o.paid_by
       LEFT JOIN staff cs ON cs.id = o.created_by
      WHERE date(COALESCE(o.paid_at, o.created_at), '+7 hours') = ${DAY} AND ${BR}
      ORDER BY o.id`
  ).all(D, ...b);

  const payments = db.prepare(
    `SELECT COALESCE(o.payment_method, 'unspecified') AS method, COUNT(*) AS orders,
            SUM(o.total - COALESCE(o.discount,0)) AS amount
       FROM orders o
      WHERE o.payment_status = 'paid' AND date(o.paid_at, '+7 hours') = ${DAY} AND ${BR}
      GROUP BY method ORDER BY amount DESC`
  ).all(D, ...b);

  const discounts = db.prepare(
    `SELECT t.code, o.discount AS amount, o.discount_reason AS reason, o.total, cs.name AS by_name, o.created_at
       FROM orders o JOIN tickets t ON t.id = o.ticket_id LEFT JOIN staff cs ON cs.id = o.created_by
      WHERE o.discount > 0 AND o.payment_status != 'void' AND date(o.created_at, '+7 hours') = ${DAY} AND ${BR}
      ORDER BY o.id`
  ).all(D, ...b);
  const discountTotal = discounts.reduce((s, d) => s + (d.amount || 0), 0);

  const voids = db.prepare(
    `SELECT t.code, o.total, o.void_kind, o.void_reason, o.voided_at, s.name AS by_name
       FROM orders o JOIN tickets t ON t.id = o.ticket_id LEFT JOIN staff s ON s.id = o.voided_by
      WHERE o.payment_status = 'void' AND date(COALESCE(o.voided_at, o.created_at), '+7 hours') = ${DAY} AND ${BR}
      ORDER BY o.voided_at DESC`
  ).all(D, ...b);

  const addons = db.prepare(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.kind = 'addon' AND o.payment_status != 'void' AND date(o.created_at, '+7 hours') = ${DAY} AND ${BR}
      GROUP BY oi.name ORDER BY qty DESC`
  ).all(D, ...b);

  const hourly = db.prepare(
    `SELECT strftime('%H', o.paid_at, '+7 hours') AS hr, COUNT(*) AS orders, SUM(o.total) AS revenue
       FROM orders o
      WHERE o.payment_status = 'paid' AND date(o.paid_at, '+7 hours') = ${DAY} AND ${BR}
      GROUP BY hr ORDER BY hr`
  ).all(D, ...b);

  // Best-selling drinks (base items only) for the day — feeds the "เมนูขายดี" chart.
  const topItems = db.prepare(
    `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.kind = 'base' AND o.payment_status = 'paid' AND date(o.paid_at, '+7 hours') = ${DAY} AND ${BR}
      GROUP BY oi.name ORDER BY qty DESC LIMIT 8`
  ).all(D, ...b);

  // By-channel sales (net of discount) + platform commission → profit after commission.
  const chanRows = db.prepare(
    `SELECT COALESCE(c.name, 'หน้าร้าน') AS channel, COALESCE(c.commission_pct, 0) AS commission_pct,
            COUNT(*) AS orders, SUM(o.total - COALESCE(o.discount,0)) AS gross
       FROM orders o LEFT JOIN channels c ON c.id = o.channel_id
      WHERE o.payment_status = 'paid' AND date(o.paid_at, '+7 hours') = ${DAY} AND ${BR}
      GROUP BY o.channel_id ORDER BY gross DESC`
  ).all(D, ...b);
  const channelsReport = chanRows.map((r) => {
    const commission = Math.round((r.gross * (r.commission_pct || 0) / 100) * 100) / 100;
    return { channel: r.channel, commission_pct: r.commission_pct || 0, orders: r.orders, gross: r.gross || 0, commission, net: Math.round(((r.gross || 0) - commission) * 100) / 100 };
  });
  const channelTotals = channelsReport.reduce((a, r) => ({ gross: a.gross + r.gross, commission: a.commission + r.commission, net: a.net + r.net }), { gross: 0, commission: 0, net: 0 });

  const voidTotals = {};
  for (const v of voids) { const k = v.void_kind || 'void'; (voidTotals[k] = voidTotals[k] || { count: 0, amount: 0 }); voidTotals[k].count++; voidTotals[k].amount += v.total || 0; }
  const paidTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const paidOrders = payments.reduce((s, p) => s + (p.orders || 0), 0);
  return { date: D, transactions, payments, paidTotal, paidOrders, discounts, discountTotal, channels: channelsReport, channelTotals, voids, voidTotals, addons, hourly, topItems };
}

// ---------- Cash drawer / Z-report (end-of-day cash-up) ----------
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
function cashComponents(branchId, sinceAt) {
  // Cash physically collected = every order paid by cash in the window — INCLUDING any
  // later refunded (paid_at persists after a void), so the refund isn't double-removed.
  const cashIn = db.prepare(`SELECT COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS v
    FROM orders o WHERE o.payment_method='cash' AND o.paid_at IS NOT NULL AND o.branch_id=? AND o.paid_at >= ?`).get(branchId, sinceAt).v || 0;
  // Cash paid back out = refunds (paid-then-voided) that had been paid by cash.
  const cashRefund = db.prepare(`SELECT COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS v
    FROM orders o WHERE o.void_kind='refund' AND o.payment_method='cash' AND o.branch_id=? AND o.voided_at >= ?`).get(branchId, sinceAt).v || 0;
  return { cashIn: r2(cashIn), cashRefund: r2(cashRefund) };
}
/** Current open cash session for a branch (+ live expected cash so far). */
export function currentCashSession(branchId = 1) {
  const s = db.prepare('SELECT * FROM cash_sessions WHERE branch_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(branchId);
  if (!s) return { open: false };
  const c = cashComponents(branchId, s.opened_at);
  return { open: true, session: s, ...c, expectedCash: r2(s.open_float + c.cashIn - c.cashRefund) };
}
/** Open a drawer with a starting float (one open session per branch at a time). */
export function openCashSession(branchId = 1, { actorId = null, openFloat = 0 } = {}) {
  if (db.prepare('SELECT id FROM cash_sessions WHERE branch_id=? AND closed_at IS NULL').get(branchId)) throw new Error('session_already_open');
  db.prepare('INSERT INTO cash_sessions (branch_id, opened_by, open_float) VALUES (?,?,?)').run(branchId, actorId, Math.max(0, Number(openFloat) || 0));
  return currentCashSession(branchId);
}
/** Close the drawer: counted vs expected -> over/short, with a Z-report summary. */
export function closeCashSession(branchId = 1, { actorId = null, countedCash = 0, note = null } = {}) {
  const cur = db.prepare('SELECT * FROM cash_sessions WHERE branch_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(branchId);
  if (!cur) throw new Error('no_open_session');
  const c = cashComponents(branchId, cur.opened_at);
  const expected = r2(cur.open_float + c.cashIn - c.cashRefund);
  const counted = r2(countedCash);
  const over = r2(counted - expected);
  db.prepare(`UPDATE cash_sessions SET closed_by=?, closed_at=datetime('now'), counted_cash=?, expected_cash=?, over_short=?, note=? WHERE id=?`)
    .run(actorId, counted, expected, over, note ? note.toString().slice(0, 200) : null, cur.id);
  return { session: db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(cur.id), openFloat: cur.open_float, ...c, expectedCash: expected, countedCash: counted, overShort: over, zreport: detailedReports({ branchId }) };
}

/** Daily reset: clear all tickets and restart numbering from 0 in every zone. */
export function resetAllZones() {
  archiveTodaySales(); // save today's sales record before clearing
  const tx = db.transaction(() => {
    // Archive a per-zone daily summary (history) before clearing the tickets.
    db.prepare(
      `INSERT OR REPLACE INTO daily_stats (date, zone_id, issued, served, no_shows, avg_wait_sec, avg_rating)
       SELECT date('now','+7 hours'), z.id, z.last_number,
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served'),
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show'),
         (SELECT CAST(AVG((julianday(called_at)-julianday(created_at))*86400) AS INTEGER) FROM tickets t WHERE t.zone_id=z.id AND t.called_at IS NOT NULL),
         (SELECT AVG(rating) FROM tickets t WHERE t.zone_id=z.id AND t.rating IS NOT NULL)
       FROM zones z`
    ).run();
    db.exec(`DELETE FROM tickets`);
    db.exec(`UPDATE zones SET last_number = 0, last_called = 0`);
  });
  tx();
  return db.prepare('SELECT id FROM zones').all().map((z) => z.id);
}

export function setZoneOpen(zoneId, isOpen) {
  db.prepare('UPDATE zones SET is_open = ? WHERE id = ?').run(isOpen ? 1 : 0, zoneId);
  return getZone(zoneId);
}

// ---------- Store open/closed (master switch for operating hours) ----------
export function firstStore() {
  return db.prepare('SELECT * FROM stores ORDER BY id LIMIT 1').get();
}
/** Open/close the whole store: flips the store flag AND every one of its zones,
 *  so the customer LIFF shows "closed" everywhere. Returns affected zone ids. */
export function setStoreOpen(storeId, isOpen) {
  const v = isOpen ? 1 : 0;
  db.prepare('UPDATE stores SET is_open=? WHERE id=?').run(v, storeId);
  db.prepare('UPDATE zones SET is_open=? WHERE store_id=?').run(v, storeId);
  return db.prepare('SELECT id FROM zones WHERE store_id=?').all(storeId).map((z) => z.id);
}
/** Is this branch within its own opening hours right now (BKK)? True if no hours configured. */
export function isStoreOpenRow(s) {
  if (!s || !s.hours_open || !s.hours_close) return true;
  const b = new Date(Date.now() + 7 * 3600 * 1000);
  const hm = b.getUTCHours() * 60 + b.getUTCMinutes(), day = b.getUTCDay();
  if (s.hours_days && !s.hours_days.split(',').filter(Boolean).includes(String(day))) return false;
  const [oh, om] = s.hours_open.split(':').map(Number), [ch, cm] = s.hours_close.split(':').map(Number);
  const openM = oh * 60 + om, closeM = ch * 60 + cm;
  return closeM > openM ? (hm >= openM && hm < closeM) : (hm >= openM || hm < closeM);
}
/** All branches with their profile + zone count + computed open_now (manual toggle AND hours). */
export function listStores() {
  return db.prepare('SELECT * FROM stores ORDER BY id').all().map((s) => ({
    ...s,
    zones: db.prepare('SELECT COUNT(*) c FROM zones WHERE store_id=?').get(s.id).c,
    open_now: (s.is_open === 1) && isStoreOpenRow(s),
  }));
}
/** Edit a branch's profile + hours. `isOpen` (manual temp open/close) handled via setStoreOpen. */
export function updateStore(id, { name, code, address, phone, isOpen, hoursOpen, hoursClose, hoursDays } = {}) {
  const cur = db.prepare('SELECT * FROM stores WHERE id=?').get(id);
  if (!cur) throw new Error('store_not_found');
  const opt = (x, col, max) => x != null ? (x === '' ? null : x.toString().slice(0, max)) : cur[col];
  const n = name != null ? (name.toString().trim().slice(0, 60) || cur.name) : cur.name;
  const ho = hoursOpen != null ? (/^\d{1,2}:\d{2}$/.test(hoursOpen) ? hoursOpen : null) : cur.hours_open;
  const hc = hoursClose != null ? (/^\d{1,2}:\d{2}$/.test(hoursClose) ? hoursClose : null) : cur.hours_close;
  const hd = hoursDays != null ? (Array.isArray(hoursDays) ? hoursDays.join(',') : String(hoursDays || '')) : cur.hours_days;
  db.prepare('UPDATE stores SET name=?, code=?, address=?, phone=?, hours_open=?, hours_close=?, hours_days=? WHERE id=?')
    .run(n, opt(code, 'code', 20), opt(address, 'address', 200), opt(phone, 'phone', 30), ho, hc, hd, id);
  if (isOpen != null) setStoreOpen(id, !!isOpen);
  return db.prepare('SELECT * FROM stores WHERE id=?').get(id);
}

// ---------- Menu (Quick-Service) ----------
// image may be a short URL or a base64 data: URL (uploaded photo) — allow a large cap.
const IMG_CAP = 300000;
export function listMenu(channelId = null, branchId = null) {
  const rows = db.prepare('SELECT id, name, name_en, price, image, category, active, soldout, sort FROM menu_items ORDER BY sort, id').all();
  // Per-branch overrides: drop items this branch disabled; apply the branch's soldout.
  if (branchId) {
    const ov = new Map(db.prepare('SELECT item_id, enabled, soldout FROM branch_menu WHERE branch_id=?').all(branchId).map((r) => [r.item_id, r]));
    for (let i = rows.length - 1; i >= 0; i--) {
      const o = ov.get(rows[i].id);
      if (o) { if (!o.enabled) { rows.splice(i, 1); continue; } if (o.soldout) rows[i].soldout = 1; }
    }
  }
  // Resolve channel/branch pricing (delivery markup, branch price override). base_price
  // keeps the storefront catalog price for display ("฿X → ฿Y").
  if (channelId || branchId) rows.forEach((r) => { r.base_price = r.price; r.price = priceFor(r.id, { channelId, branchId }); });
  // BOM availability: items with a recipe get `makeable` (cups left from stock) + `stockSoldout`
  // (makeable<=0). Items without a recipe are unlimited (makeable=null) — unaffected.
  const mk = menuMakeable();
  const dtid = deliveryTierId();
  rows.forEach((r) => {
    if (mk.has(r.id)) { r.makeable = mk.get(r.id); r.stockSoldout = r.makeable <= 0 ? 1 : 0; } else { r.makeable = null; r.stockSoldout = 0; }
    r.price_delivery = dtid ? (db.prepare('SELECT price FROM item_prices WHERE item_id=? AND tier_id=? AND branch_id=0').get(r.id, dtid)?.price ?? null) : null;
  });
  return rows;
}

// ---------- Branches (Phase 2): a tenant's shops ----------
export function listBranches(tenantId = null) {
  const rows = db.prepare(`SELECT id, name, code, is_open, address, phone, hours_open, hours_close, hours_days FROM stores WHERE (? IS NULL OR tenant_id=?) ORDER BY id`).all(tenantId, tenantId);
  return rows.map((b) => ({
    ...b,
    zones: db.prepare('SELECT name FROM zones WHERE store_id=? ORDER BY id').all(b.id).map((z) => z.name),
    open_now: (b.is_open === 1) && isStoreOpenRow(b),
  }));
}
export function createBranch({ name, code = null, tenantId = 1 } = {}) {
  const n = (name || '').toString().trim().slice(0, 60);
  if (!n) throw new Error('name_required');
  const info = db.prepare('INSERT INTO stores (name, code, tenant_id) VALUES (?,?,?)').run(n, code ? code.toString().slice(0, 20) : null, tenantId);
  const id = Number(info.lastInsertRowid);
  // A branch needs at least one zone to issue queue numbers / take orders.
  db.prepare('INSERT INTO zones (store_id, name, prefix) VALUES (?,?,?)').run(id, 'Zone A', 'A');
  return { id, name: n, code, zones: 1 };
}
export function renameBranch(id, { name, code }) {
  const cur = db.prepare('SELECT * FROM stores WHERE id=?').get(id);
  if (!cur) throw new Error('branch_not_found');
  const n = name != null ? (name.toString().trim().slice(0, 60) || cur.name) : cur.name;
  const c = code !== undefined ? (code ? code.toString().slice(0, 20) : null) : cur.code;
  db.prepare('UPDATE stores SET name=?, code=? WHERE id=?').run(n, c, id);
  return { id: Number(id), name: n, code: c };
}
/** Per-branch menu overrides: list catalog items with this branch's enable/price/soldout. */
export function listBranchMenu(branchId) {
  return db.prepare(
    `SELECT mi.id, mi.name, mi.name_en, mi.price AS base_price, mi.category,
            COALESCE(bm.enabled, 1) AS enabled, bm.price_override,
            COALESCE(bm.soldout, mi.soldout) AS soldout
       FROM menu_items mi LEFT JOIN branch_menu bm ON bm.item_id = mi.id AND bm.branch_id = ?
      WHERE mi.active = 1 ORDER BY mi.sort, mi.id`
  ).all(branchId);
}
export function setBranchMenuOverride(branchId, itemId, { enabled, priceOverride, soldout } = {}) {
  const cur = db.prepare('SELECT * FROM branch_menu WHERE branch_id=? AND item_id=?').get(branchId, itemId) || { enabled: 1, price_override: null, soldout: 0, sort: null };
  const en = enabled != null ? (enabled ? 1 : 0) : cur.enabled;
  const po = priceOverride !== undefined ? (priceOverride === null || priceOverride === '' ? null : Math.max(0, Number(priceOverride) || 0)) : cur.price_override;
  const so = soldout != null ? (soldout ? 1 : 0) : cur.soldout;
  db.prepare(`INSERT INTO branch_menu (branch_id, item_id, enabled, price_override, soldout) VALUES (?,?,?,?,?)
              ON CONFLICT(branch_id, item_id) DO UPDATE SET enabled=excluded.enabled, price_override=excluded.price_override, soldout=excluded.soldout`)
    .run(branchId, itemId, en, po, so);
  return { ok: true, branchId: Number(branchId), itemId: Number(itemId), enabled: en, priceOverride: po, soldout: so };
}

// ---------- Inventory: raw materials + stock movements ----------
const round2i = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
export function listIngredients() {
  const rows = db.prepare('SELECT * FROM ingredients WHERE active=1 ORDER BY name').all();
  return rows.map((r) => ({ ...r, low: r.stock_qty <= r.low_threshold, value: round2i(r.stock_qty * r.avg_cost) }));
}
export function inventorySummary() {
  const list = listIngredients();
  return {
    items: list.length,
    totalValue: round2i(list.reduce((s, r) => s + r.value, 0)),
    lowCount: list.filter((r) => r.low).length,
  };
}
export function addIngredient({ name, unit = 'หน่วย', lowThreshold = 0, costPrice = 0, branchId = null } = {}) {
  const n = (name || '').toString().trim().slice(0, 60);
  if (!n) throw new Error('name_required');
  // costPrice = purchase price per unit (สfor costing). Stock starts at 0 — fill in later.
  const info = db.prepare('INSERT INTO ingredients (name, unit, low_threshold, avg_cost, branch_id) VALUES (?,?,?,?,?)')
    .run(n, (unit || 'หน่วย').toString().slice(0, 20), Math.max(0, Number(lowThreshold) || 0), Math.max(0, Number(costPrice) || 0), branchId);
  return db.prepare('SELECT * FROM ingredients WHERE id=?').get(info.lastInsertRowid);
}
export function updateIngredient(id, { name, unit, lowThreshold, active, costPrice }) {
  const cur = db.prepare('SELECT * FROM ingredients WHERE id=?').get(id);
  if (!cur) throw new Error('ingredient_not_found');
  const n = name != null ? (name.toString().trim().slice(0, 60) || cur.name) : cur.name;
  const u = unit != null ? (unit.toString().slice(0, 20) || cur.unit) : cur.unit;
  const lt = lowThreshold != null ? Math.max(0, Number(lowThreshold) || 0) : cur.low_threshold;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const c = costPrice != null ? Math.max(0, Number(costPrice) || 0) : cur.avg_cost;
  db.prepare('UPDATE ingredients SET name=?, unit=?, low_threshold=?, active=?, avg_cost=? WHERE id=?').run(n, u, lt, a, c, id);
  return db.prepare('SELECT * FROM ingredients WHERE id=?').get(id);
}
/** Record a stock movement. purchase=qty in + (optional) cost → weighted-avg cost;
 *  use/waste=qty out; adjust=set on-hand to qty (stock count). */
export function recordStockMove(ingredientId, { kind, qty, cost = null, note = null, actorId = null } = {}) {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
  if (!ing) throw new Error('ingredient_not_found');
  let q = Number(qty) || 0;
  let newStock, moveQty, newAvg = ing.avg_cost;
  if (kind === 'purchase') {
    q = Math.max(0, q); moveQty = q; newStock = round2i(ing.stock_qty + q);
    const c = Number(cost) || 0;
    if (c > 0 && newStock > 0) newAvg = round2i((ing.stock_qty * ing.avg_cost + c) / newStock);
  } else if (kind === 'adjust') {
    newStock = Math.max(0, round2i(q)); moveQty = round2i(newStock - ing.stock_qty);
  } else if (kind === 'return') {           // ingredients back from a not-made / cancelled order
    q = Math.max(0, q); moveQty = q; newStock = round2i(ing.stock_qty + q);  // avg cost unchanged
  } else { // use | waste
    q = Math.max(0, q); moveQty = -q; newStock = Math.max(0, round2i(ing.stock_qty - q));
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE ingredients SET stock_qty=?, avg_cost=? WHERE id=?').run(newStock, newAvg, ingredientId);
    db.prepare('INSERT INTO stock_moves (ingredient_id, branch_id, kind, qty, cost, note, actor) VALUES (?,?,?,?,?,?,?)')
      .run(ingredientId, ing.branch_id, kind, moveQty, kind === 'purchase' ? (Number(cost) || null) : null, note ? note.toString().slice(0, 200) : null, actorId);
  });
  tx();
  return db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
}
export function stockMoves(ingredientId, limit = 50) {
  return db.prepare('SELECT * FROM stock_moves WHERE ingredient_id=? ORDER BY id DESC LIMIT ?').all(ingredientId, limit);
}

// ---------- Recipes (bill-of-materials) → auto stock deduction on sale ----------
/** Ingredients (with qty per unit) that make up one menu item. */
export function getRecipe(menuItemId) {
  return db.prepare(
    `SELECT r.ingredient_id AS ingredientId, r.qty, i.name, i.unit, i.stock_qty
       FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
      WHERE r.menu_item_id = ? ORDER BY i.name`
  ).all(menuItemId);
}
/** Replace a menu item's recipe with the given {ingredientId, qty} rows (qty>0 kept). */
export function setRecipe(menuItemId, rows = []) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM recipes WHERE menu_item_id=?').run(menuItemId);
    const ins = db.prepare('INSERT INTO recipes(menu_item_id, ingredient_id, qty) VALUES(?,?,?)');
    for (const r of rows) {
      const q = Number(r.qty) || 0; const ing = Number(r.ingredientId);
      if (q > 0 && ing) ins.run(menuItemId, ing, q);
    }
  });
  tx();
  return getRecipe(menuItemId);
}
/** How many cups of each menu item can still be made from current ingredient stock, per its
 *  recipe. Returns Map(menuItemId → makeable count) ONLY for items that have a recipe. */
export function menuMakeable() {
  const rows = db.prepare(
    `SELECT r.menu_item_id AS mid, r.qty, i.stock_qty FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.qty>0`
  ).all();
  const byMenu = new Map();
  for (const r of rows) {
    const can = Math.floor((Number(r.stock_qty) || 0) / r.qty);
    byMenu.set(r.mid, Math.min(byMenu.has(r.mid) ? byMenu.get(r.mid) : Infinity, can));
  }
  return byMenu;
}
/** Auto-deduct ingredient stock for every line of a paid order, per its menu item's recipe.
 *  No-op for any line whose menu item has no recipe → safe/dormant until recipes are set. */
function deductStockForOrder(order) {
  try {
    const items = db.prepare('SELECT name, qty FROM order_items WHERE order_id=?').all(order.id);
    const code = db.prepare('SELECT code FROM tickets WHERE id=?').get(order.ticket_id)?.code || ('#' + order.id);
    for (const it of items) {
      const base = String(it.name).split(' · ')[0];   // strip the " · หวาน X%" suffix
      const mi = db.prepare('SELECT id FROM menu_items WHERE name=? LIMIT 1').get(base);
      if (!mi) continue;
      const recipe = db.prepare('SELECT ingredient_id, qty FROM recipes WHERE menu_item_id=?').all(mi.id);
      for (const r of recipe) {
        const use = (Number(r.qty) || 0) * (Number(it.qty) || 1);
        if (use > 0) try {
          const before = db.prepare('SELECT stock_qty, low_threshold, name, unit FROM ingredients WHERE id=?').get(r.ingredient_id);
          const after = recordStockMove(r.ingredient_id, { kind: 'use', qty: use, note: 'ขายอัตโนมัติ ' + code });
          // Notify the owner the moment a sale pushes an ingredient to/under its low mark.
          if (before && before.low_threshold > 0 && before.stock_qty > before.low_threshold && after.stock_qty <= before.low_threshold)
            notifyOwner(`⚠️ วัตถุดิบใกล้หมด: ${before.name} เหลือ ${after.stock_qty} ${before.unit}`);
        } catch { /* never block a sale on stock */ }
      }
    }
  } catch { /* deduction must never break a payment */ }
}

// ---------- Staff & roles (Phase 1) ----------
const ROLES = new Set(['owner', 'manager', 'cashier']);
const branchIdsOf = (staffId) =>
  db.prepare('SELECT branch_id FROM staff_branches WHERE staff_id=?').all(staffId).map((r) => r.branch_id);

export function listStaff() {
  const rows = db.prepare('SELECT id, name, role, active FROM staff ORDER BY role, name').all();
  return rows.map((s) => ({ ...s, branchIds: s.role === 'owner' ? [] : branchIdsOf(s.id) }));
}
// True if `pin` already belongs to another active staffer (PINs identify the user at login).
function pinTaken(pin, exceptId = null) {
  return db.prepare('SELECT id, pin_hash FROM staff WHERE active=1').all()
    .some((s) => s.id !== Number(exceptId) && verifyPin(pin, s.pin_hash));
}
export function createStaff({ name, pin, role = 'cashier', branchIds = [], tenantId = 1 }) {
  const n = (name || '').toString().trim().slice(0, 60);
  if (!n) throw new Error('name_required');
  const p = (pin || '').toString().trim();
  if (!/^\d{4,8}$/.test(p)) throw new Error('pin_must_be_4_8_digits');
  if (!ROLES.has(role)) throw new Error('bad_role');
  if (pinTaken(p)) throw new Error('pin_taken');
  const info = db.prepare('INSERT INTO staff (name, pin_hash, role, tenant_id) VALUES (?,?,?,?)')
    .run(n, hashPin(p), role, tenantId);
  const id = info.lastInsertRowid;
  if (role !== 'owner') for (const b of branchIds) db.prepare('INSERT OR IGNORE INTO staff_branches (staff_id, branch_id) VALUES (?,?)').run(id, b);
  return { id: Number(id), name: n, role, branchIds: role === 'owner' ? [] : branchIds };
}
export function updateStaff(id, { name, role, active, pin, branchIds }) {
  const cur = db.prepare('SELECT * FROM staff WHERE id=?').get(id);
  if (!cur) throw new Error('staff_not_found');
  const n = name != null ? (name.toString().trim().slice(0, 60) || cur.name) : cur.name;
  const r = role != null ? role : cur.role;
  if (!ROLES.has(r)) throw new Error('bad_role');
  const a = active != null ? (active ? 1 : 0) : cur.active;
  // Never deactivate or demote the last active owner (lock-out guard).
  if ((cur.role === 'owner') && (r !== 'owner' || !a)) {
    const owners = db.prepare("SELECT COUNT(*) c FROM staff WHERE role='owner' AND active=1").get().c;
    if (owners <= 1) throw new Error('cannot_remove_last_owner');
  }
  let pinHash = cur.pin_hash;
  if (pin != null && pin !== '') {
    const p = pin.toString().trim();
    if (!/^\d{4,8}$/.test(p)) throw new Error('pin_must_be_4_8_digits');
    if (pinTaken(p, id)) throw new Error('pin_taken');
    pinHash = hashPin(p);
  }
  db.prepare('UPDATE staff SET name=?, role=?, active=?, pin_hash=? WHERE id=?').run(n, r, a, pinHash, id);
  if (Array.isArray(branchIds)) {
    db.prepare('DELETE FROM staff_branches WHERE staff_id=?').run(id);
    if (r !== 'owner') for (const b of branchIds) db.prepare('INSERT OR IGNORE INTO staff_branches (staff_id, branch_id) VALUES (?,?)').run(id, b);
  }
  return { id: Number(id), name: n, role: r, active: a, branchIds: r === 'owner' ? [] : branchIdsOf(id) };
}
export function deactivateStaff(id) {
  const cur = db.prepare('SELECT * FROM staff WHERE id=?').get(id);
  if (!cur) throw new Error('staff_not_found');
  if (cur.role === 'owner') {
    const owners = db.prepare("SELECT COUNT(*) c FROM staff WHERE role='owner' AND active=1").get().c;
    if (owners <= 1) throw new Error('cannot_remove_last_owner');
  }
  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(id);
  return { ok: true };
}

// ---------- Price tiers & sales channels (multi-price per product) ----------
export function listPriceTiers() {
  return db.prepare('SELECT * FROM price_tiers ORDER BY sort, id').all();
}
export function listChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY sort, id').all();
}
/** Owner edits a price tier's default markup % over base (and optionally its name). */
export function updatePriceTier(id, { markup_pct, name }) {
  const cur = db.prepare('SELECT * FROM price_tiers WHERE id=?').get(id);
  if (!cur) throw new Error('tier_not_found');
  const mk = markup_pct != null ? Math.max(0, Math.min(1000, Number(markup_pct) || 0)) : cur.markup_pct;
  const nm = name != null ? (name.toString().trim().slice(0, 40) || cur.name) : cur.name;
  db.prepare('UPDATE price_tiers SET markup_pct=?, name=? WHERE id=?').run(mk, nm, id);
  return db.prepare('SELECT * FROM price_tiers WHERE id=?').get(id);
}
/** Owner edits a channel's platform commission % (and active/name). */
export function updateChannel(id, { commission_pct, active, name }) {
  const cur = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
  if (!cur) throw new Error('channel_not_found');
  const c = commission_pct != null ? Math.max(0, Math.min(100, Number(commission_pct) || 0)) : cur.commission_pct;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const nm = name != null ? (name.toString().trim().slice(0, 40) || cur.name) : cur.name;
  db.prepare('UPDATE channels SET commission_pct=?, active=?, name=? WHERE id=?').run(c, a, nm, id);
  return db.prepare('SELECT * FROM channels WHERE id=?').get(id);
}

// ---------- Payment tenders (HOW money is collected; per-tender daily reconciliation) ----------
/** Payment tenders. includeInactive=false → only active ones (for pickers). */
export function listTenders(includeInactive = false) {
  return db.prepare(`SELECT * FROM tenders ${includeInactive ? '' : 'WHERE active=1'} ORDER BY sort, id`).all();
}
/** Owner edits a tender (label / active / fee% / sort). */
export function updateTender(id, { label, active, fee_pct, sort } = {}) {
  const cur = db.prepare('SELECT * FROM tenders WHERE id=?').get(id);
  if (!cur) throw new Error('tender_not_found');
  const lb = label != null ? (label.toString().trim().slice(0, 40) || cur.label) : cur.label;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const f = fee_pct != null ? Math.max(0, Math.min(100, Number(fee_pct) || 0)) : cur.fee_pct;
  const s = sort != null ? (Number(sort) || 0) : cur.sort;
  db.prepare('UPDATE tenders SET label=?, active=?, fee_pct=?, sort=? WHERE id=?').run(lb, a, f, s, id);
  return db.prepare('SELECT * FROM tenders WHERE id=?').get(id);
}
/**
 * Per-tender settlement totals for a day (default = today, BKK). Returns EVERY active tender
 * (0 if unused that day) so the owner can tick each line against what the app/bank actually
 * paid out. amount = net of discount (what the customer paid); net = amount minus any fee%.
 * Any paid orders whose method isn't a known tender (legacy promptpay/slip/other) are listed too.
 */
export function tenderRecon({ date = null, branchId = null } = {}) {
  const DAY = "COALESCE(?, date('now','+7 hours'))";
  const BR = "(? IS NULL OR o.branch_id = ?)";
  const rows = db.prepare(
    `SELECT COALESCE(o.payment_method,'unspecified') AS code, COUNT(*) AS orders,
            COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS amount
       FROM orders o
      WHERE o.payment_status='paid' AND date(o.paid_at,'+7 hours') = ${DAY} AND ${BR}
      GROUP BY code`
  ).all(date, branchId, branchId);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  const tenders = listTenders();
  const lines = tenders.map((t) => {
    const hit = byCode[t.code] || { orders: 0, amount: 0 };
    const amount = r2(hit.amount);
    const fee = r2(amount * (t.fee_pct || 0) / 100);
    return { code: t.code, label: t.label, kind: t.kind, fee_pct: t.fee_pct || 0,
             orders: hit.orders || 0, amount, fee, net: r2(amount - fee) };
  });
  const known = new Set(tenders.map((t) => t.code));
  for (const r of rows) {
    if (!known.has(r.code)) {
      const amount = r2(r.amount);
      lines.push({ code: r.code, label: r.code, kind: 'other', fee_pct: 0, orders: r.orders, amount, fee: 0, net: amount });
    }
  }
  const total = lines.reduce((a, l) => ({ orders: a.orders + l.orders, amount: r2(a.amount + l.amount), net: r2(a.net + l.net) }), { orders: 0, amount: 0, net: 0 });
  return { date, lines, total };
}

// ---------- Loyalty STAMP CARD (our own — LINE Reward Cards can't be awarded via API) ----------
// Model: 1 stamp per drink cup; collect `stamps_per_reward` cups → 1 free drink (≤49฿).
// "points" in the DB == stamps. Disabled by default (owner enables later).
export function loyaltyEnabled() { return getSetting('loyalty:enabled', '0') === '1'; }
export function setLoyaltyEnabled(on) { setSetting('loyalty:enabled', on ? '1' : '0'); return { enabled: !!on }; }
// SlipOK auto-verify is an OWNER TOGGLE (default OFF) on top of the env creds, so the shop
// can run manual "attach slip → cashier confirms" until it has a PromptPay account SlipOK
// can verify against. Flip on (someday) only when a valid PromptPay merchant is configured.
export function slipAutoEnabled() { return getSetting('slip:auto', '0') === '1'; }
export function setSlipAuto(on) { setSetting('slip:auto', on ? '1' : '0'); return { slipAuto: !!on }; }
// Receipt printing prepared but DORMANT (default OFF) — owner flips on after wiring a printer.
export function printEnabled() { return getSetting('print:enabled', '0') === '1'; }
export function setPrintEnabled(on) { setSetting('print:enabled', on ? '1' : '0'); return { printEnabled: !!on }; }
// Auto-void abandoned (unpaid) pending orders after N minutes so they don't pile up on the
// till. Default 30 min; 0 disables. Owner-configurable in ⚙ จัดการ.
export function getPendingVoidMinutes() { return Math.max(0, Math.floor(Number(getSetting('pending:void_min', '30')) || 0)); }
export function setPendingVoidMinutes(m) { const n = Math.max(0, Math.floor(Number(m) || 0)); setSetting('pending:void_min', String(n)); return { pendingVoidMinutes: n }; }
// Store opening hours → auto-close. Empty open/close = always open (no behaviour change).
// days = CSV of open weekdays (0=Sun..6=Sat); empty = open every day. Times are "HH:MM" BKK.
export function getStoreHours() {
  return { open: getSetting('hours:open', '') || '', close: getSetting('hours:close', '') || '', days: getSetting('hours:days', '') || '' };
}
export function setStoreHours({ open, close, days } = {}) {
  if (open != null) setSetting('hours:open', /^\d{1,2}:\d{2}$/.test(open) ? open : '');
  if (close != null) setSetting('hours:close', /^\d{1,2}:\d{2}$/.test(close) ? close : '');
  if (days != null) setSetting('hours:days', Array.isArray(days) ? days.join(',') : String(days || ''));
  return getStoreHours();
}
/** Is the shop open right now (Bangkok time)? True when no hours are configured. */
export function isStoreOpen() {
  const h = getStoreHours();
  if (!h.open || !h.close) return true;
  const b = new Date(Date.now() + 7 * 3600 * 1000);          // shift to BKK wall-clock
  const hm = b.getUTCHours() * 60 + b.getUTCMinutes(), day = b.getUTCDay();
  if (h.days && !h.days.split(',').filter(Boolean).includes(String(day))) return false;
  const [oh, om] = h.open.split(':').map(Number), [ch, cm] = h.close.split(':').map(Number);
  const openM = oh * 60 + om, closeM = ch * 60 + cm;
  return closeM > openM ? (hm >= openM && hm < closeM) : (hm >= openM || hm < closeM);  // handle past-midnight
}
// Owner LINE notifications: DORMANT until the owner stores their LINE userId. notifyOwner()
// no-ops when unset or when the LINE channel is off — so this is safe to ship disabled.
export function getOwnerLineId() { return (getSetting('owner:line_id', '') || '').trim(); }
export function setOwnerLineId(id) { setSetting('owner:line_id', (id || '').toString().trim().slice(0, 80)); return { ownerLineId: getOwnerLineId() }; }
export function notifyOwner(text) { const id = getOwnerLineId(); if (id && text) pushText(id, text); return { sent: !!id }; }
/** Compose a short Thai end-of-day summary from today's report. */
export function composeDailySummary(branchId = null) {
  const r = dailyReport(branchId); const v = r.voided || {};
  const lines = [
    '📊 สรุปยอดวันนี้ — YO-DEE Yogurt',
    `💰 ยอดขาย ฿${r.revenue} (${r.cupsSold || 0} แก้ว)`,
    `📈 กำไรสุทธิ ฿${Math.round(r.pnl?.netProfit || 0)}`,
    `❌ ยกเลิก ${v.cancelled?.orders || 0} · 💸 คืนเงิน ${v.refunded?.orders || 0} · 🗑️ ของเสีย ${v.waste?.cups || 0} แก้ว`,
  ];
  if (r.avgRating != null) lines.push(`⭐ รีวิวเฉลี่ย ${r.avgRating} (${r.ratingCount} รีวิว)`);
  return lines.join('\n');
}
export function pushOwnerSummary(branchId = null) { const text = composeDailySummary(branchId); const r = notifyOwner(text); return { ...r, text }; }
/** Cups (drink stamps) needed to earn one free drink. */
export function getStampsPerReward() { return Math.max(1, Math.round(Number(getSetting('loyalty:stamps_per_reward', '10')) || 10)); }
export function setStampsPerReward(n) {
  const v = Math.max(1, Math.round(Number(n) || 0));
  setSetting('loyalty:stamps_per_reward', v);
  return { stamps_per_reward: v };
}
/** Welcome head-start: bonus stamps granted on a customer's FIRST paid LINE order — the hook
 *  that pulls counter customers into ordering via LINE (endowed-progress effect). 0 = off. */
export function getWelcomeBonus() { return Math.max(0, Math.round(Number(getSetting('loyalty:welcome_bonus', '2')) || 0)); }
export function setWelcomeBonus(n) { const v = Math.max(0, Math.round(Number(n) || 0)); setSetting('loyalty:welcome_bonus', String(v)); return { welcomeBonus: v }; }
/** Loyal-customer badge tier from lifetime stamps earned. null below the first threshold. */
export function loyaltyTier(lifetime) {
  const l = lifetime || 0;
  if (l >= 100) return { key: 'vip', label: 'VIP', emoji: '👑' };
  if (l >= 50) return { key: 'gold', label: 'ลูกค้าประจำ', emoji: '🏅' };
  if (l >= 20) return { key: 'silver', label: 'ขาประจำ', emoji: '⭐' };
  return null;
}
/** Bangkok-local helpers for the birthday free drink. */
function bkkMonthDay() { return db.prepare("SELECT strftime('%m-%d', datetime('now','+7 hours')) md").get().md; }
function bkkYear() { return db.prepare("SELECT strftime('%Y', datetime('now','+7 hours')) y").get().y; }
function birthdayMD(bd) { if (!bd) return null; const m = String(bd).match(/(\d{2})-(\d{2})$/); return m ? m[1] + '-' + m[2] : null; }
export function isBirthdayToday(bd) { const md = birthdayMD(bd); return !!md && md === bkkMonthDay(); }
/** Save a customer's birthday (optional, 'YYYY-MM-DD' or 'MM-DD'). Upserts the customer row. */
export function setCustomerBirthday(key, birthday) {
  if (!key) throw new Error('customer_required');
  if (!birthdayMD(birthday)) throw new Error('bad_birthday');
  const val = String(birthday).slice(0, 10);
  db.prepare(`INSERT INTO customers (line_user_id, birthday) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET birthday=excluded.birthday`).run(key, val);
  return { ok: true, birthday: val, isBirthday: isBirthdayToday(val) };
}
/** Current + lifetime stamp balance for a customer key (line_user_id) + badge tier + birthday. */
export function loyaltyBalance(key) {
  if (!key) return { key, points: 0, lifetime: 0, tier: null, birthday: null, isBirthday: false };
  const c = db.prepare('SELECT points, lifetime_points, birthday FROM customers WHERE line_user_id=?').get(key);
  const lifetime = c ? (c.lifetime_points || 0) : 0;
  return { key, points: c ? (c.points || 0) : 0, lifetime, tier: loyaltyTier(lifetime), birthday: c ? (c.birthday || null) : null, isBirthday: c ? isBirthdayToday(c.birthday) : false };
}
/** Referral: each customer has a short invite code (YD<base36 rowid>). A NEW friend enters it,
 *  and when that friend completes their FIRST paid order both sides get bonus stamps. */
export function getReferralBonus() { return Math.max(0, Math.round(Number(getSetting('loyalty:referral_bonus', '5')) || 0)); }
function refCodeFor(rowid) { return 'YD' + Number(rowid).toString(36).toUpperCase(); }
function rowidFromRefCode(code) { const m = String(code || '').trim().toUpperCase().match(/^YD([0-9A-Z]+)$/); return m ? parseInt(m[1], 36) : null; }
function hasLoyaltyHistory(key) { return !!db.prepare('SELECT 1 FROM loyalty_moves WHERE customer_key=? LIMIT 1').get(key); }
export function getReferralCode(key) {
  if (!key) return null;
  const c = db.prepare('SELECT rowid, referral_code FROM customers WHERE line_user_id=?').get(key);
  if (!c) return null;
  if (c.referral_code) return c.referral_code;
  const code = refCodeFor(c.rowid);
  db.prepare('UPDATE customers SET referral_code=? WHERE rowid=?').run(code, c.rowid);
  return code;
}
export function referralStatus(key) {
  if (!key) return { code: null, referredBy: null, eligible: false };
  const c = db.prepare('SELECT referred_by FROM customers WHERE line_user_id=?').get(key);
  return { code: getReferralCode(key), referredBy: c ? (c.referred_by || null) : null, eligible: !(c && c.referred_by) && !hasLoyaltyHistory(key) };
}
export function applyReferralCode(key, code) {
  if (!key) throw new Error('customer_required');
  if (hasLoyaltyHistory(key)) throw new Error('not_new_customer');
  const me = db.prepare('SELECT referred_by FROM customers WHERE line_user_id=?').get(key);
  if (me && me.referred_by) throw new Error('already_referred');
  const rid = rowidFromRefCode(code);
  if (!rid) throw new Error('bad_code');
  const ref = db.prepare('SELECT line_user_id FROM customers WHERE rowid=?').get(rid);
  if (!ref) throw new Error('code_not_found');
  if (ref.line_user_id === key) throw new Error('own_code');
  db.prepare('INSERT INTO customers (line_user_id, referred_by) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET referred_by=excluded.referred_by').run(key, ref.line_user_id);
  return { ok: true };
}
export function loyaltyHistory(key, limit = 30) {
  if (!key) return [];
  return db.prepare('SELECT kind, points, order_id, note, at FROM loyalty_moves WHERE customer_key=? ORDER BY id DESC LIMIT ?').all(key, limit);
}
/**
 * Award stamps for a paid order, once: 1 stamp per drink cup (toppings excluded). Skips
 * cashier/walk-in (no line_user_id) and no-ops when loyalty is disabled. Idempotent per order.
 * Returns {key,name,awarded,balance} for a LINE "+N ดวง" push, or null.
 */
export function awardPoints(orderId) {
  if (!loyaltyEnabled()) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return null;
  const t = db.prepare('SELECT line_user_id, customer_name FROM tickets WHERE id=?').get(order.ticket_id);
  if (!t || !t.line_user_id) return null;
  if (db.prepare("SELECT 1 FROM loyalty_moves WHERE order_id=? AND kind='earn'").get(orderId)) return null;
  // 1 stamp per drink cup (non-topping lines); sweetened drink names don't match the menu
  // catalog so they COALESCE to 'drink' — counted, which is correct.
  const pts = db.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) c FROM order_items oi LEFT JOIN menu_items mi ON mi.name = oi.name
      WHERE oi.order_id=? AND COALESCE(mi.category,'drink') != 'topping'`
  ).get(orderId).c;
  if (pts <= 0) return null;
  const key = t.line_user_id;
  const name = t.customer_name && !['LINE order', 'Order', 'Walk-in'].includes(t.customer_name) ? t.customer_name : null;
  // First-ever LINE order for this customer? Grant a one-time welcome head-start.
  const isFirst = !db.prepare("SELECT 1 FROM loyalty_moves WHERE customer_key=? AND kind='earn' LIMIT 1").get(key);
  const bonus = isFirst ? getWelcomeBonus() : 0;
  // Birthday free drink: once per calendar year, a full reward's worth of stamps when the
  // customer orders on their birthday (and has saved one).
  const cust = db.prepare('SELECT birthday, referred_by FROM customers WHERE line_user_id=?').get(key);
  const yr = bkkYear();
  const bdayBonus = (cust && isBirthdayToday(cust.birthday) && !db.prepare("SELECT 1 FROM loyalty_moves WHERE customer_key=? AND note=?").get(key, 'birthday ' + yr))
    ? getStampsPerReward() : 0;
  // Referral: on the invited friend's FIRST order, both the friend and the referrer get a bonus.
  const referrerKey = (isFirst && cust && cust.referred_by) ? cust.referred_by : null;
  const refBonus = referrerKey ? getReferralBonus() : 0;
  const total = pts + bonus + bdayBonus + refBonus;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO customers (line_user_id, name, points, lifetime_points)
       VALUES (?,?,?,?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         points = customers.points + excluded.points,
         lifetime_points = customers.lifetime_points + excluded.points,
         name = COALESCE(customers.name, excluded.name)`
    ).run(key, name, total, total);
    db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id) VALUES (?, 'earn', ?, ?)`).run(key, pts, orderId);
    if (bonus > 0) db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(key, bonus, orderId, 'โบนัสต้อนรับออเดอร์แรกผ่านไลน์');
    if (bdayBonus > 0) db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(key, bdayBonus, orderId, 'birthday ' + yr);
    if (refBonus > 0 && referrerKey) {
      db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(key, refBonus, orderId, 'referral (เพื่อนชวน)');
      db.prepare('UPDATE customers SET points=points+?, lifetime_points=lifetime_points+? WHERE line_user_id=?').run(refBonus, refBonus, referrerKey);
      db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(referrerKey, refBonus, orderId, 'referral (เพื่อนที่ชวนสั่งครั้งแรก)');
    }
  })();
  if (refBonus > 0 && referrerKey) pushQueue(referrerKey, `👫 เพื่อนที่คุณชวนสั่งครั้งแรกแล้ว! รับ +${refBonus} ดวง 🎉`, null);
  return { key, name, awarded: pts, bonus, bdayBonus, refBonus, firstOrder: isFirst, balance: loyaltyBalance(key).points };
}
/** Active rewards (cheapest first) for the customer to browse. */
export function listRewards(all = false) {
  return db.prepare(`SELECT * FROM rewards ${all ? '' : 'WHERE active=1'} ORDER BY sort, cost_points, id`).all();
}
export function addReward({ name, cost_points, image = null } = {}) {
  const nm = (name || '').toString().trim().slice(0, 60);
  const cost = Math.max(1, Math.round(Number(cost_points) || 0));
  if (!nm) throw new Error('name_required');
  const info = db.prepare('INSERT INTO rewards (name, cost_points, image) VALUES (?,?,?)').run(nm, cost, image ? image.toString() : null);
  return db.prepare('SELECT * FROM rewards WHERE id=?').get(info.lastInsertRowid);
}
export function updateReward(id, { name, cost_points, active, image } = {}) {
  const cur = db.prepare('SELECT * FROM rewards WHERE id=?').get(id);
  if (!cur) throw new Error('reward_not_found');
  const nm = name != null ? (name.toString().trim().slice(0, 60) || cur.name) : cur.name;
  const cost = cost_points != null ? Math.max(1, Math.round(Number(cost_points) || 0)) : cur.cost_points;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const img = image !== undefined ? (image || null) : cur.image;
  db.prepare('UPDATE rewards SET name=?, cost_points=?, active=?, image=? WHERE id=?').run(nm, cost, a, img, id);
  return db.prepare('SELECT * FROM rewards WHERE id=?').get(id);
}
/** Redeem a reward for a customer (deduct points, log the move). Guards insufficient balance. */
export function redeemReward(key, rewardId, actorId = null) {
  if (!key) throw new Error('customer_required');
  const r = db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(rewardId);
  if (!r) throw new Error('reward_not_found');
  const bal = loyaltyBalance(key).points;
  if (bal < r.cost_points) throw new Error('insufficient_points');
  db.transaction(() => {
    db.prepare('UPDATE customers SET points = points - ? WHERE line_user_id=?').run(r.cost_points, key);
    db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, note) VALUES (?, 'redeem', ?, ?)`).run(key, -r.cost_points, `${r.name}${actorId ? ' (โดยพนักงาน #' + actorId + ')' : ''}`);
  })();
  return { ok: true, redeemed: r.name, cost: r.cost_points, balance: bal - r.cost_points };
}

/** Owner sets an explicit per-item price for a tier (0/absent branch = all branches). */
// Per-item Delivery price = an item_prices row for the (single, shared) เดลิเวอรี่ tier.
function deliveryTierId() { return db.prepare('SELECT id FROM price_tiers WHERE is_default=0 ORDER BY sort LIMIT 1').get()?.id || null; }
export function getMenuDeliveryPrice(itemId) {
  const tid = deliveryTierId(); if (!tid) return null;
  const r = db.prepare('SELECT price FROM item_prices WHERE item_id=? AND tier_id=? AND branch_id=0').get(itemId, tid);
  return r ? r.price : null;
}
export function setMenuDeliveryPrice(itemId, price) {
  const tid = deliveryTierId(); if (!tid) return { ok: false };
  if (price == null || price === '' || Number(price) <= 0) { db.prepare('DELETE FROM item_prices WHERE item_id=? AND tier_id=? AND branch_id=0').run(itemId, tid); return { ok: true, cleared: true }; }
  return setItemPrice(itemId, tid, price, 0);
}
export function setItemPrice(itemId, tierId, price, branchId = 0) {
  const p = Math.max(0, Number(price) || 0);
  db.prepare(`INSERT INTO item_prices (item_id, tier_id, branch_id, price) VALUES (?,?,?,?)
              ON CONFLICT(item_id, tier_id, branch_id) DO UPDATE SET price=excluded.price`)
    .run(Number(itemId), Number(tierId), Number(branchId) || 0, p);
  return { ok: true };
}
const defaultTier = () => db.prepare('SELECT * FROM price_tiers WHERE is_default=1 LIMIT 1').get();

/**
 * Resolve the price of an item for a (branch, channel) combination.
 * Order: explicit price book (branch-specific → all-branch) → base × tier markup → base.
 * Base = the branch's storefront override (branch_menu) or the catalog price.
 * `channelId` selects the tier (defaults to the storefront tier when absent).
 */
export function priceFor(itemId, { branchId = null, channelId = null } = {}) {
  const item = db.prepare('SELECT price FROM menu_items WHERE id=?').get(itemId);
  if (!item) return null;
  let tier = null;
  if (channelId) {
    const ch = db.prepare('SELECT tier_id FROM channels WHERE id=?').get(channelId);
    if (ch?.tier_id) tier = db.prepare('SELECT * FROM price_tiers WHERE id=?').get(ch.tier_id);
  }
  if (!tier) tier = defaultTier();
  // 1) explicit price book entry for this tier (branch-specific, then all-branch=0)
  if (tier) {
    let row = branchId
      ? db.prepare('SELECT price FROM item_prices WHERE item_id=? AND tier_id=? AND branch_id=?').get(itemId, tier.id, branchId)
      : null;
    if (!row) row = db.prepare('SELECT price FROM item_prices WHERE item_id=? AND tier_id=? AND branch_id=0').get(itemId, tier.id);
    if (row) return Math.round((row.price + Number.EPSILON) * 100) / 100;
  }
  // 2) base price (per-branch storefront override or catalog), optionally × tier markup
  let base = item.price;
  if (branchId) {
    const bm = db.prepare('SELECT price_override FROM branch_menu WHERE branch_id=? AND item_id=?').get(branchId, itemId);
    if (bm && bm.price_override != null) base = bm.price_override;
  }
  const markup = tier?.markup_pct || 0;
  return markup ? Math.round(base * (1 + markup / 100)) : base;
}

/** Net revenue an order keeps after the channel's platform commission (for P&L by channel). */
export function channelNet(amount, channelId) {
  const ch = channelId ? db.prepare('SELECT commission_pct FROM channels WHERE id=?').get(channelId) : null;
  const pct = ch?.commission_pct || 0;
  return Math.round((amount * (1 - pct / 100) + Number.EPSILON) * 100) / 100;
}
export function addMenuItem({ name, name_en, price, image, category }) {
  const n = (name || '').toString().trim().slice(0, 80);
  if (!n) throw new Error('name_required');
  const p = Math.max(0, Number(price) || 0);
  const cat = category === 'topping' ? 'topping' : 'drink';
  const s = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM menu_items').get().s;
  const info = db.prepare('INSERT INTO menu_items (name, name_en, price, image, category, sort) VALUES (?,?,?,?,?,?)')
    .run(n, (name_en || '').toString().slice(0, 80) || null, p, (image || '').toString().slice(0, IMG_CAP) || null, cat, s);
  return db.prepare('SELECT * FROM menu_items WHERE id=?').get(info.lastInsertRowid);
}
export function updateMenuItem(id, { name, name_en, price, image, active, soldout, category }) {
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
  if (!cur) throw new Error('item_not_found');
  const n = name != null ? (name.toString().trim().slice(0, 80) || cur.name) : cur.name;
  const en = name_en != null ? (name_en.toString().slice(0, 80) || null) : cur.name_en;
  const p = price != null ? Math.max(0, Number(price) || 0) : cur.price;
  const img = image != null ? (image.toString().slice(0, IMG_CAP) || null) : cur.image;
  const cat = category != null ? (category === 'topping' ? 'topping' : 'drink') : cur.category;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const so = soldout != null ? (soldout ? 1 : 0) : cur.soldout;
  db.prepare('UPDATE menu_items SET name=?, name_en=?, price=?, image=?, category=?, active=?, soldout=? WHERE id=?').run(n, en, p, img, cat, a, so, id);
  return db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
}
export function deleteMenuItem(id) {
  db.prepare('DELETE FROM menu_items WHERE id=?').run(id);
  return { ok: true };
}

// ---------- Customers: remember LINE customers for reorder suggestions ----------
/** Upsert a LINE customer's profile + counters after they place an order. Best-effort:
 *  never block the order on a customer-record failure. */
function recordCustomerOrder(lineUserId, name) {
  if (!lineUserId) return;
  try {
    db.prepare(
      `INSERT INTO customers (line_user_id, name, last_order_at, order_count)
       VALUES (?,?,datetime('now'),1)
       ON CONFLICT(line_user_id) DO UPDATE SET
         name = COALESCE(excluded.name, customers.name),
         last_order_at = datetime('now'),
         order_count = customers.order_count + 1`
    ).run(lineUserId, name && !['LINE order', 'Order', 'Walk-in'].includes(name) ? name : null);
  } catch { /* best-effort */ }
}

/** Reorder suggestions for a returning LINE customer: their most-ordered drinks
 *  (with current price/image) + their last order's lines for a one-tap repeat. */
export function customerSuggestions(lineUserId) {
  if (!lineUserId) return { known: false };
  const cust = db.prepare('SELECT name, order_count, last_order_at FROM customers WHERE line_user_id=?').get(lineUserId);
  const favourites = db.prepare(
    `SELECT oi.name,
            SUM(oi.qty) AS qty,
            COUNT(DISTINCT o.id) AS times,
            mi.id AS item_id, mi.price AS price, mi.image AS image, mi.soldout AS soldout, mi.active AS active
     FROM order_items oi
     JOIN orders o  ON o.id = oi.order_id
     JOIN tickets t ON t.id = o.ticket_id
     LEFT JOIN menu_items mi ON mi.name = oi.name
     WHERE t.line_user_id = ? AND oi.kind = 'base' AND o.payment_status != 'void'
     GROUP BY oi.name
     ORDER BY qty DESC, times DESC
     LIMIT 5`
  ).all(lineUserId).filter((f) => f.active == null || f.active === 1);
  // Last order (most recent ticket) grouped into drink + nested toppings, for "reorder the same".
  const lastTicket = db.prepare(
    `SELECT t.id FROM tickets t JOIN orders o ON o.ticket_id=t.id
     WHERE t.line_user_id=? AND o.payment_status!='void' ORDER BY t.id DESC LIMIT 1`
  ).get(lineUserId);
  const lastOrder = lastTicket ? orderForTicket(lastTicket.id) : null;
  const known = !!cust || favourites.length > 0;
  return {
    known,
    name: cust?.name || null,
    orderCount: cust?.order_count || 0,
    favourites: favourites.map((f) => ({ name: f.name, qty: f.qty, times: f.times, itemId: f.item_id, price: f.price, image: f.image, soldout: f.soldout === 1 })),
    lastOrder: lastOrder ? { lines: lastOrder.lines, total: lastOrder.total } : null,
  };
}

// ---------- Orders: tie a quick-service order to a fresh queue number ----------
/**
 * Create an order + a fresh queue number in one transaction.
 * opts.source: 'cashier' (default) or 'customer' (self-ordered via the LINE app).
 * opts.lineUserId / opts.customerName: tie the ticket to a LINE customer so they can
 * resume it and receive pushes. Customer self-orders are deduped (one open order each).
 */
export function createOrder(zoneId, items, opts = {}) {
  const { source = 'cashier', lineUserId = null, customerName = null, actorId = null, channelId = null } = opts;
  const lines = (Array.isArray(items) ? items : [])
    .map((it) => ({
      name: (it.name || '').toString().slice(0, 60),
      price: Math.max(0, Number(it.price) || 0),
      qty: Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1))),
    }))
    .filter((it) => it.name);
  if (!lines.length) throw new Error('empty_order');
  const zone = getZone(zoneId);
  if (!zone) throw new Error('zone_not_found');
  if (!zone.is_open) throw new Error('zone_closed');

  // A LINE customer may only hold one open order at a time (prevents accidental
  // double-submits creating duplicate queue numbers). Return the existing one.
  if (source === 'customer' && lineUserId) {
    const existing = findActiveTicket(zoneId, lineUserId);
    if (existing) {
      const e = new Error('already_in_queue');
      e.ticketId = existing.id; e.code = existing.code;
      throw e;
    }
  }

  const total = lines.reduce((s, it) => s + it.price * it.qty, 0);
  const label = customerName || (source === 'customer' ? 'LINE order' : 'Order');
  // Classify each line as a base drink or an addon (topping) for exact addon reporting.
  const toppingNames = new Set(
    db.prepare("SELECT name FROM menu_items WHERE category='topping'").all().map((r) => r.name)
  );
  // Pay-first model: create the ticket in 'pending' state with NO queue number yet.
  // The real queue number is issued only once payment is confirmed (assignQueueNumber),
  // so abandoned/unpaid orders never consume a number and the kitchen only sees paid work.
  const dedup = source === 'customer' && lineUserId;
  const tx = db.transaction(() => {
    // Atomic dedup: for a LINE customer, only insert if they have NO active order — done as a
    // single conditional INSERT so two near-simultaneous submits (cold-start retry/reload) can
    // never both create a ticket. A pre-check above already fast-paths the common case.
    const tinfo = dedup
      ? db.prepare(
          `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, status)
           SELECT ?,?,0,'',1,?,?,'pending'
           WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE zone_id=? AND line_user_id=? AND status IN ('pending','waiting','called'))`
        ).run(zone.store_id, zoneId, lineUserId, label, zoneId, lineUserId)
      : db.prepare(
          `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, status)
           VALUES (?,?,?,?,?,?,?,'pending')`
        ).run(zone.store_id, zoneId, 0, '', 1, lineUserId, label);
    if (dedup && tinfo.changes === 0) {                 // a race lost: an active order already exists
      const ex = findActiveTicket(zoneId, lineUserId);
      const e = new Error('already_in_queue');
      e.ticketId = ex?.id; e.code = ex?.code;
      throw e;
    }
    const oinfo = db.prepare('INSERT INTO orders (ticket_id, total, source, branch_id, created_by, channel_id) VALUES (?,?,?,?,?,?)')
      .run(tinfo.lastInsertRowid, total, source, zone.store_id, actorId, channelId);
    const ins = db.prepare('INSERT INTO order_items (order_id, name, price, qty, kind) VALUES (?,?,?,?,?)');
    for (const it of lines) ins.run(oinfo.lastInsertRowid, it.name, it.price, it.qty, toppingNames.has(it.name) ? 'addon' : 'base');
    logSaleEvent({ branchId: zone.store_id, ticketId: tinfo.lastInsertRowid, orderId: oinfo.lastInsertRowid, type: 'order_created', amount: total, actor: actorId, meta: { source } });
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id=?').get(tinfo.lastInsertRowid), total };
  });
  const r = tx();

  // Remember this LINE customer for next-visit reorder suggestions (best-effort, deferred so the
  // extra write doesn't add a remote round-trip to the order response).
  if (source === 'customer' && lineUserId) setImmediate(() => { try { recordCustomerOrder(lineUserId, customerName); } catch { /* best-effort */ } });

  // Self-order: remind to pay (the queue number is pushed later, at payment confirmation).
  if (source === 'customer' && lineUserId) {
    pushQueue(lineUserId,
      `🧾 รับออเดอร์แล้ว ยอด ฿${r.total}\n` +
      `กรุณาชำระเงินให้เรียบร้อย แล้วระบบจะออกหมายเลขคิวให้ทันที 🎫`,
      queueLink(zoneId), 'ชำระเงิน / ดูออเดอร์');
  }
  return r;
}

/** Pay-first: issue the real queue number for a 'pending' ticket (called once payment is
 *  confirmed). Idempotent — a ticket that already has a number is returned unchanged, so it
 *  is safe to call from every payment path (online/LINE Pay/cashier) without double-issuing. */
export function assignQueueNumber(ticketId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.number > 0) return t;            // already issued — never re-number
  return db.transaction(() => {
    const cur = db.prepare('SELECT last_number, prefix FROM zones WHERE id=?').get(t.zone_id);
    const next = cur.last_number + 1;
    db.prepare('UPDATE zones SET last_number=? WHERE id=?').run(next, t.zone_id);
    db.prepare("UPDATE tickets SET number=?, code=?, status='waiting' WHERE id=? AND number=0")
      .run(next, code(cur.prefix, next), ticketId);
    return db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  })();
}

/** Cashier marks a ticket's order paid (collected cash / PromptPay at the counter).
 *  opts.actorId = staff who took payment; opts.method = cash|promptpay|slip|other.
 *  Under the pay-first model this is also what ISSUES the queue number. */
export function setOrderPaid(ticketId, opts = {}) {
  const { actorId = null, method = null, skipLoyalty = false } = opts;
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  db.prepare(`UPDATE orders SET payment_status='paid', paid_at=datetime('now'), paid_by=?, payment_method=COALESCE(?, payment_method) WHERE id=?`)
    .run(actorId, method, order.id);
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'paid', amount: order.total, actor: actorId, meta: { method: method || 'cash' } });
  // Now that payment is confirmed, issue the queue number (idempotent) and tell the customer.
  let ticket = null;
  try { ticket = assignQueueNumber(Number(ticketId)); }
  catch { ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId); }
  // Auto-deduct ingredient stock per recipe (dormant until recipes are defined).
  deductStockForOrder(order);
  // Auto-earn loyalty stamps for a paid LINE order (no-op for cashier/walk-in or if disabled).
  // skipLoyalty = a fully-redeemed (free) order shouldn't earn new stamps on the free cup.
  let loyalty = null;
  if (!skipLoyalty) { try { loyalty = awardPoints(order.id); } catch { /* never block a payment on loyalty */ } }
  if (ticket && ticket.line_user_id) {
    const ahead = aheadCount(ticket);
    let msg = `✅ ชำระเงินเรียบร้อย ฿${order.total}\n` +
      `🎫 หมายเลขคิวของคุณ: ${ticket.code}\n` +
      `คิวรอก่อนหน้า: ${ahead}`;
    if (loyalty && loyalty.awarded != null) {
      // Recognition: greet returning customers, show stamps earned + progress to the next free drink.
      const per = getStampsPerReward();
      const bal = loyalty.balance || 0;
      const free = Math.floor(bal / per);
      const bonusTxt = (loyalty.bonus ? ` (+${loyalty.bonus} ดวงต้อนรับ! 🎁)` : '') + (loyalty.bdayBonus ? ` (+${loyalty.bdayBonus} ดวงวันเกิด! 🎂)` : '');
      const greet = loyalty.name ? `ขอบคุณค่ะคุณ ${loyalty.name} 💛\n` : '';
      msg = greet + msg + `\n\n⭐ ได้ ${loyalty.awarded} ดวง${bonusTxt} · สะสมรวม ${bal} ดวง`;
      msg += free >= 1
        ? `\n🎉 ครบ ${per} ดวงแล้ว! แจ้งพนักงานเพื่อรับเครื่องดื่มฟรีได้เลยในออเดอร์ถัดไป`
        : `\n🥤 อีก ${per - bal} แก้ว ได้ฟรี 1 แก้ว!`;
    } else {
      msg += `\nเราจะแจ้งเตือนเมื่อเครื่องดื่มใกล้พร้อมค่ะ`;
    }
    pushQueue(ticket.line_user_id, msg, queueLink(ticket.zone_id), 'ดูคิว / แต้มของฉัน');
  }
  return { ok: true, ticketId: Number(ticketId), total: order.total, loyalty, code: ticket?.code || null, number: ticket?.number || null };
}

/** Customer attaches a payment slip (no SlipOK): stored for the cashier to eyeball, and the
 *  order is flagged 'claimed' so the cashier knows to verify + confirm. */
export function attachSlip(ticketId, imageData) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') return { ok: true, already: true };
  db.prepare(`INSERT INTO slips (order_id, ticket_id, image) VALUES (?,?,?)
              ON CONFLICT(order_id) DO UPDATE SET image=excluded.image, at=datetime('now')`).run(order.id, Number(ticketId), imageData);
  db.prepare(`UPDATE orders SET payment_status='claimed' WHERE id=? AND payment_status!='paid'`).run(order.id);
  return { ok: true };
}
/** Customer asks for a refund (paid online but can't come). Flags the order so the cashier
 *  sees it in history and processes the refund. */
export function requestRefund(ticketId, reason = null) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status !== 'paid') throw new Error('not_paid');
  if (order.void_kind) return { ok: true, already: true };
  db.prepare(`UPDATE orders SET refund_requested=1, refund_note=? WHERE id=?`).run(reason ? reason.toString().slice(0, 200) : null, order.id);
  return { ok: true };
}
/** The slip image a customer attached for this ticket's order, or null. */
export function getSlip(ticketId) {
  const order = db.prepare('SELECT id FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return null;
  return db.prepare('SELECT image, at FROM slips WHERE order_id=?').get(order.id) || null;
}

/** Customer taps "I've paid (PromptPay)" — flags the order 'claimed' so the cashier
 *  knows to verify the incoming transfer in their bank app, then confirm Paid. */
export function claimOrderPaid(ticketId) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') return { ok: true, already: true };
  db.prepare(`UPDATE orders SET payment_status='claimed' WHERE id=? AND payment_status!='paid'`).run(order.id);
  return { ok: true };
}

/** Apply a bill-level discount to a ticket's order. amount is clamped to [0, subtotal].
 *  Net due = total − discount. Recorded as a 'discount' sale_event. */
export function setOrderDiscount(ticketId, { amount, reason = null, actorId = null } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'void') throw new Error('order_void');
  let amt = Math.max(0, Number(amount) || 0);
  amt = Math.min(amt, order.total);
  amt = Math.round(amt * 100) / 100;
  const rsn = reason ? reason.toString().slice(0, 200) : null;
  db.prepare('UPDATE orders SET discount=?, discount_reason=? WHERE id=?').run(amt, rsn, order.id);
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'discount', amount: amt, actor: actorId, meta: { reason: rsn } });
  return { ok: true, ticketId: Number(ticketId), discount: amt, total: order.total, net: Math.round((order.total - amt) * 100) / 100 };
}

/** Redeem a stamp reward against a specific UNPAID LINE order: deduct the reward's stamps and
 *  apply a free-drink discount (cheapest drink in the cart, capped 49฿) to that order. The order
 *  already carries the customer's line_user_id, so no QR/id handshake is needed at the counter —
 *  the cashier just taps "แลกฟรี" on the customer's order. One redemption per order. */
export function redeemRewardOnOrder(ticketId, rewardId = null, actorId = null) {
  const t = db.prepare('SELECT line_user_id FROM tickets WHERE id=?').get(ticketId);
  if (!t || !t.line_user_id) throw new Error('not_line_order');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') throw new Error('order_already_paid');
  if (order.payment_status === 'void') throw new Error('order_void');
  if (db.prepare("SELECT 1 FROM loyalty_moves WHERE order_id=? AND kind='redeem'").get(order.id)) throw new Error('already_redeemed');
  const key = t.line_user_id;
  const reward = rewardId
    ? db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(rewardId)
    : db.prepare('SELECT * FROM rewards WHERE active=1 ORDER BY cost_points, id LIMIT 1').get();
  if (!reward) throw new Error('reward_not_found');
  const bal = loyaltyBalance(key).points;
  if (bal < reward.cost_points) throw new Error('insufficient_points');
  const cheapest = db.prepare(
    `SELECT MIN(oi.price) p FROM order_items oi LEFT JOIN menu_items mi ON mi.name=oi.name
      WHERE oi.order_id=? AND COALESCE(mi.category,'drink')!='topping' AND oi.price>0`
  ).get(order.id)?.p;
  const room = Math.max(0, order.total - (order.discount || 0));
  const free = Math.round(Math.min(49, cheapest || room, room) * 100) / 100;
  if (free <= 0) throw new Error('nothing_to_discount');
  const reason = '🎁 แลกแต้ม: ' + reward.name;
  db.transaction(() => {
    db.prepare('UPDATE customers SET points = points - ? WHERE line_user_id=?').run(reward.cost_points, key);
    db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'redeem', ?, ?, ?)`).run(key, -reward.cost_points, order.id, reason);
  })();
  const res = setOrderDiscount(ticketId, { amount: (order.discount || 0) + free, reason, actorId });
  if (t.line_user_id) pushQueue(t.line_user_id, `🎁 ใช้แต้มแลกเครื่องดื่มฟรีแล้ว! ลด ฿${free}\nคงเหลือ ${bal - reward.cost_points} ดวง · ขอบคุณที่อุดหนุนค่ะ 💛`, null);
  // If the reward fully covers the bill (net 0), don't make the customer pay anything more —
  // settle it as a 'reward' tender and issue the queue number right away.
  let autoPaid = false;
  if (res.net <= 0) {
    try { setOrderPaid(ticketId, { actorId, method: 'reward', skipLoyalty: true }); autoPaid = true; }
    catch { /* leave it unpaid if completion fails */ }
  }
  return { ok: true, redeemed: reward.name, cost: reward.cost_points, freeAmount: free, balance: bal - reward.cost_points, net: autoPaid ? 0 : res.net, autoPaid };
}

/** Cashier cancels/voids a ticket and its order (customer changed their mind, etc.).
 *  opts.actorId = staff; opts.reason = free text; opts.kind = optional explicit category.
 *  void_kind: 'refund' if the order was already paid (money goes back); else 'waste' when
 *  the cashier marks it discarded (made-but-binned → a no-revenue COST), otherwise 'void'
 *  (cancelled before any product/money — neutral). All three are excluded from sales. */
// Reverse a paid order's recipe deduction — ingredients go BACK to stock when the cancel
// reason says the drink was never made (e.g. customer cancelled / wrong order / can't make).
function returnStockForOrder(order) {
  try {
    const items = db.prepare('SELECT name, qty FROM order_items WHERE order_id=?').all(order.id);
    const code = db.prepare('SELECT code FROM tickets WHERE id=?').get(order.ticket_id)?.code || ('#' + order.id);
    for (const it of items) {
      const base = String(it.name).split(' · ')[0];
      const mi = db.prepare('SELECT id FROM menu_items WHERE name=? LIMIT 1').get(base);
      if (!mi) continue;
      for (const r of db.prepare('SELECT ingredient_id, qty FROM recipes WHERE menu_item_id=?').all(mi.id)) {
        const back = (Number(r.qty) || 0) * (Number(it.qty) || 1);
        if (back > 0) try { recordStockMove(r.ingredient_id, { kind: 'return', qty: back, note: 'คืนสต๊อก (ยกเลิก) ' + code }); } catch { /* never block a void */ }
      }
    }
  } catch { /* stock return must never break a void */ }
}
/** Undo an order's loyalty effects when it's voided: returns redeemed stamps to the customer
 *  and removes any stamps it earned, keeping the ledger consistent. Returns net points returned
 *  to the ticket's own customer (positive = points given back). */
function reverseLoyaltyForOrder(orderId, ownerKey) {
  const moves = db.prepare("SELECT customer_key, kind, points FROM loyalty_moves WHERE order_id=? AND kind IN ('earn','redeem')").all(orderId);
  if (!moves.length) return 0;
  const byKey = {};
  for (const m of moves) { const k = (byKey[m.customer_key] = byKey[m.customer_key] || { pts: 0, life: 0 }); k.pts += m.points; if (m.kind === 'earn') k.life += m.points; }
  let returnedToOwner = 0;
  for (const key of Object.keys(byKey)) {
    const v = byKey[key];
    if (v.pts === 0 && v.life === 0) continue;
    db.prepare('UPDATE customers SET points = MAX(0, points - ?), lifetime_points = MAX(0, lifetime_points - ?) WHERE line_user_id=?').run(v.pts, v.life, key);
    db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'adjust', ?, ?, ?)`).run(key, -v.pts, orderId, 'ยกเลิกออเดอร์ — ปรับแต้มกลับ');
    if (key === ownerKey) returnedToOwner = -v.pts;   // -(net) : a net redeem (neg) returns positive points
  }
  return returnedToOwner;
}

export function cancelOrderTicket(ticketId, threshold, opts = {}) {
  const { actorId = null, reason = null, kind: kindOpt = null, restock = false } = opts;
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  const wasPaid = !!(order && order.payment_status === 'paid');   // paid => stock was deducted
  const kind = wasPaid ? 'refund' : (kindOpt === 'waste' ? 'waste' : 'void');
  // Void/refund: mark the order void (even if it was already paid -> a refund) so it
  // drops out of the report and its revenue is deducted from sales.
  db.prepare(`UPDATE orders SET payment_status='void', void_kind=?, void_reason=?, voided_at=datetime('now'), voided_by=? WHERE ticket_id=?`)
    .run(kind, reason, actorId, ticketId);
  // If the drink was never made (restock reason) AND its stock had been deducted (paid), put
  // the ingredients back. A "made then discarded" reason leaves stock deducted (it was a waste).
  if (order && wasPaid && restock) returnStockForOrder(order);
  // Undo loyalty: return any redeemed stamps + remove any stamps earned on this order — BUT only
  // if the drink wasn't already served. Once served, the product cost is incurred and the free
  // drink was handed over, so points are never returned (owner rule).
  const pointsReturned = (order && t.status !== 'served') ? reverseLoyaltyForOrder(order.id, t.line_user_id) : 0;
  if (order) logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: kind, amount: order.total, actor: actorId, meta: { reason, restock, pointsReturned } });
  db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(ticketId);
  if (t.line_user_id) {
    pushQueue(t.line_user_id,
      `❌ ออเดอร์ ${t.code} ถูกยกเลิกโดยร้านค่ะ\n` +
      (pointsReturned > 0 ? `🔄 คืน ${pointsReturned} ดวงเข้าบัญชีของคุณแล้ว\n` : '') +
      `หากมีข้อสงสัย กรุณาสอบถามพนักงาน ขอบคุณค่ะ`, null);
  }
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return { ok: true };
}

/** Auto-void abandoned pending tickets (pay-first orders that were never paid). Voids any
 *  'pending' ticket whose latest order is still unpaid and was created more than the configured
 *  number of minutes ago. Returns the affected zone ids so callers can refresh live views.
 *  A 0-minute setting disables the sweep. Safe to call frequently (idempotent on already-void). */
/** Owner "start fresh" — wipe TRANSACTION data only (orders, sales, queue history, loyalty
 *  ledger, cash rounds, audit, slips) and reset each zone's queue counter to 0. KEEPS all
 *  configuration: menu, stores, zones, staff, settings, recipes, ingredients + stock, rewards,
 *  price tiers, channels, tenders. Used once after test runs before real trading begins.
 *  Atomic; returns the row count removed per table. */
export function clearTransactions() {
  // order matters for FKs: order_items → orders → tickets; the rest are independent.
  const tables = ['order_items', 'orders', 'tickets', 'sale_events', 'loyalty_moves', 'cash_sessions', 'daily_stats', 'sales_history', 'customers', 'slips'];
  return db.transaction(() => {
    const removed = {};
    for (const t of tables) {
      try { removed[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; db.prepare(`DELETE FROM ${t}`).run(); }
      catch { removed[t] = 'skip'; }   // table absent on an older schema → ignore
    }
    db.prepare('UPDATE zones SET last_number=0, last_called=0').run();   // queue numbers restart at 1
    return removed;
  })();
}

export function sweepStalePending({ actorId = null } = {}) {
  const mins = getPendingVoidMinutes();
  if (!(mins > 0)) return { voided: 0, zones: [] };
  const rows = db.prepare(
    `SELECT t.id, t.zone_id, t.line_user_id, o.id AS order_id, o.branch_id, o.total
       FROM tickets t
       JOIN orders o ON o.id = (SELECT id FROM orders WHERE ticket_id=t.id ORDER BY id DESC LIMIT 1)
      WHERE t.status='pending' AND o.payment_status NOT IN ('paid','void')
        AND t.created_at <= datetime('now', ?)`
  ).all(`-${mins} minutes`);
  if (!rows.length) return { voided: 0, zones: [] };
  const zones = new Set();
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE orders SET payment_status='void', void_kind='void', void_reason='auto: หมดเวลาชำระ', voided_at=datetime('now'), voided_by=? WHERE id=?`).run(actorId, r.order_id);
      db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(r.id);
      logSaleEvent({ branchId: r.branch_id, ticketId: r.id, orderId: r.order_id, type: 'void', amount: r.total, actor: actorId, meta: { reason: 'auto_timeout' } });
      zones.add(r.zone_id);
    }
  })();
  // Best-effort: tell each customer their unpaid order expired (graceful no-op without a token).
  for (const r of rows) {
    if (r.line_user_id) pushQueue(r.line_user_id, '⌛ ออเดอร์ของคุณหมดเวลาชำระและถูกยกเลิกอัตโนมัติ\nสั่งใหม่ได้ตลอดเลยค่ะ 🙂', null);
  }
  return { voided: rows.length, zones: [...zones] };
}

export function orderForTicket(ticketId) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return null;
  const rows = db.prepare(
    `SELECT oi.name, oi.price, oi.qty, COALESCE(mi.category,'drink') AS category
     FROM order_items oi LEFT JOIN menu_items mi ON mi.name = oi.name WHERE oi.order_id=?`
  ).all(order.id);
  // Group toppings under the drink above them (orders insert drink-then-its-toppings).
  const lines = [];
  for (const r of rows) {
    if (r.category === 'topping' && lines.length) lines[lines.length - 1].toppings.push({ name: r.name, price: r.price, qty: r.qty });
    else lines.push({ name: r.name, price: r.price, qty: r.qty, toppings: [] });
  }
  return { total: order.total, discount: order.discount || 0, items: rows, lines, payment_status: order.payment_status || 'unpaid', method: order.payment_method || null, source: order.source || 'cashier', refund_requested: order.refund_requested || 0, refund_note: order.refund_note || null, created_at: order.created_at, paid_at: order.paid_at };
}

// Generic, non-personal labels we never need to mask.
const PUBLIC_LABELS = new Set(['Order', 'LINE order', 'Walk-in']);
/** PDPA: hide customer names from the public snapshot/stream; cashier (PIN) sees them. */
function maskName(n) {
  if (!n || PUBLIC_LABELS.has(n)) return n || null;
  const first = Array.from(n.trim())[0] || '';
  return first ? first + '…' : null;
}

/**
 * Snapshot of a zone for cashier/display: waiting list + recently called (+ orders).
 * `reveal` (cashier only, PIN-checked) returns real customer names; otherwise masked.
 */
export function zoneSnapshot(zoneId, { reveal = false } = {}) {
  const zone = getZone(zoneId);
  if (!zone) return null;
  const waiting = db.prepare(
    `SELECT id, code, number, party_size, customer_name, notified_soon FROM tickets
     WHERE zone_id=? AND status='waiting' ORDER BY number ASC`
  ).all(zoneId);
  const recentCalled = db.prepare(
    `SELECT id, code, number, party_size, customer_name, called_at FROM tickets
     WHERE zone_id=? AND status='called' ORDER BY called_at DESC LIMIT 5`
  ).all(zoneId);
  // Pay-first: orders awaiting payment (no queue number yet). The cashier confirms payment
  // here, which issues the number and moves them into `waiting`.
  const pending = db.prepare(
    `SELECT id, code, number, party_size, customer_name, created_at FROM tickets
     WHERE zone_id=? AND status='pending' ORDER BY id ASC`
  ).all(zoneId);
  if (!reveal) { waiting.forEach((t) => { t.customer_name = maskName(t.customer_name); });
                 recentCalled.forEach((t) => { t.customer_name = maskName(t.customer_name); });
                 pending.forEach((t) => { t.customer_name = maskName(t.customer_name); }); }
  const attach = (t) => {
    const o = orderForTicket(t.id);
    if (o) {
      t.order_total = o.total;
      t.order_discount = o.discount || 0;
      t.order_net = Math.round((o.total - (o.discount || 0)) * 100) / 100;
      t.order_summary = o.items.map((i) => `${i.qty}× ${i.name}`).join(', ');
      t.order_lines = o.lines;               // grouped: drink + its toppings (dash sub-lines)
      t.payment_status = o.payment_status;   // 'unpaid' | 'paid' | 'void'
      t.order_source = o.source;             // 'cashier' | 'customer'
      t.order_created_at = o.created_at;     // when the order was placed (UTC)
      t.order_paid_at = o.paid_at;           // when it was paid (UTC), if paid
    }
    // Cashier-only: attach the LINE customer's stamp balance so staff can redeem on the spot.
    if (reveal && loyaltyEnabled()) {
      const li = db.prepare('SELECT line_user_id FROM tickets WHERE id=?').get(t.id)?.line_user_id;
      if (li) { const b = loyaltyBalance(li); t.loy_points = b.points; t.loy_tier = b.tier ? b.tier.emoji : null; }
    }
    return t;
  };
  waiting.forEach(attach); recentCalled.forEach(attach); pending.forEach(attach);
  // Only the cashier (reveal) needs the awaiting-payment list; public/display omit it.
  return { zone, waiting, recentCalled, waitingCount: waiting.length, pending: reveal ? pending : [] };
}

export function ticketView(ticketId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) return null;
  const zone = getZone(t.zone_id);
  const o = orderForTicket(t.id);
  // Loyalty summary for the in-app "wow" — stamps earned on this paid order + welcome bonus.
  let loyalty = null;
  if (t.line_user_id && o && o.payment_status === 'paid' && loyaltyEnabled()) {
    const ord = db.prepare('SELECT id FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(t.id);
    const earns = db.prepare("SELECT points, note FROM loyalty_moves WHERE order_id=? AND kind='earn'").all(ord.id);
    if (earns.length) {
      const awarded = earns.filter((e) => !e.note).reduce((s, e) => s + e.points, 0);
      const bonus = earns.filter((e) => e.note).reduce((s, e) => s + e.points, 0);
      loyalty = { awarded, bonus, firstOrder: bonus > 0, balance: loyaltyBalance(t.line_user_id).points, per: getStampsPerReward() };
    }
  }
  return {
    id: t.id, code: t.code, number: t.number, status: t.status, party_size: t.party_size, rating: t.rating,
    zone: zone.name, ahead: t.status === 'waiting' ? aheadCount(t) : 0,
    last_called: zone.last_called ? `${zone.prefix}${pad(zone.last_called)}` : null,
    order: o ? { total: o.total, discount: o.discount, items: o.items, lines: o.lines, paid: o.payment_status === 'paid', status: o.payment_status, method: o.method, created_at: o.created_at, paid_at: o.paid_at, refund_requested: o.refund_requested || 0 } : null,
    loyalty,
  };
}

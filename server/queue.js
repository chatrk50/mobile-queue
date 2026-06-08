import { db, getSetting, setSetting } from './db.js';
import { pushQueue } from './line.js';
import { hashPin, verifyPin } from './auth.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;

/** Append a row to the immutable sale_events audit/transaction trail. Best-effort:
 *  a logging failure must never block the actual sale. */
function logSaleEvent({ branchId = null, ticketId = null, orderId = null, type, amount = 0, actor = null, meta = null }) {
  try {
    db.prepare('INSERT INTO sale_events (branch_id, ticket_id, order_id, type, amount, actor, meta) VALUES (?,?,?,?,?,?,?)')
      .run(branchId, ticketId, orderId, type, amount, actor, meta ? JSON.stringify(meta) : null);
  } catch { /* audit is best-effort */ }
}

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
    `SELECT * FROM tickets WHERE zone_id = ? AND line_user_id = ? AND status IN ('waiting','called')
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
     WHERE o.payment_status != 'void' AND (? IS NULL OR o.branch_id=?)   -- exclude void; optional branch
     GROUP BY oi.name ORDER BY revenue DESC`
  ).all(...B);
  const grossSales = itemSales.reduce((s, i) => s + (i.revenue || 0), 0);
  itemSales.forEach((i) => { i.pct = grossSales ? i.revenue / grossSales : 0; });
  const drinkSales = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.revenue, 0);
  const toppingSales = grossSales - drinkSales;
  const cups = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.qty, 0);
  // Bill discounts on non-void orders reduce NET sales. revenue = gross − discounts
  // (defaults to gross since discounts are 0 until used — no behavior change).
  const discounts = db.prepare(`SELECT COALESCE(SUM(o.discount),0) AS d FROM orders o WHERE o.payment_status != 'void' AND (? IS NULL OR o.branch_id=?)`).get(...B).d || 0;
  const revenue = Math.round((grossSales - discounts) * 100) / 100;

  // Cancelled / refunded (voided) orders — counted separately, NOT in sales above.
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
  const voided = { orders: vAgg.orders, amount: vAgg.amount, cups: vCups.cups };

  // P&L from the financial settings (today's sales vs prorated daily fixed costs).
  const f = getFinanceSettings(branchId);
  const ingredient = f.ingredientPct * revenue;
  const packaging = f.packagingPerCup * cups;
  const cogs = ingredient + packaging;
  const grossProfit = revenue - cogs;
  const monthlyOpex = f.rent + f.wages + f.utilities + f.supplies + f.marketing;
  const dailyOpex = f.daysPerMonth > 0 ? monthlyOpex / f.daysPerMonth : monthlyOpex;
  const netProfit = grossProfit - dailyOpex;
  // Break-even: how many cups/day cover the prorated fixed costs, using the menu's
  // average drink price (so it's meaningful even before the first sale of the day).
  const refAvg = db.prepare("SELECT AVG(price) AS a FROM menu_items WHERE category='drink' AND active=1").get().a || 0;
  const contribPerCup = refAvg * (1 - f.ingredientPct) - f.packagingPerCup;
  const breakEvenCups = contribPerCup > 0 ? Math.ceil(dailyOpex / contribPerCup) : null;
  const targetDaily = f.targetRevenue > 0 && f.daysPerMonth > 0 ? f.targetRevenue / f.daysPerMonth : null;
  const pnl = {
    drinkSales, toppingSales, cups,
    ingredient, packaging, cogs,
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
    return {
      id: t.id, code: t.code, status: t.status, customer_name: t.customer_name,
      closed_at: t.closed_at,
      order_total: o ? o.total : null,
      payment_status: o ? o.payment_status : null,
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
    `SELECT t.code, o.id AS order_id, o.created_at, o.paid_at, o.total, o.discount,
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
  return { date: D, transactions, payments, paidTotal, paidOrders, discounts, discountTotal, channels: channelsReport, channelTotals, voids, voidTotals, addons, hourly };
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
  return rows;
}

// ---------- Branches (Phase 2): a tenant's shops ----------
export function listBranches(tenantId = null) {
  const rows = db.prepare(`SELECT id, name, code, is_open FROM stores WHERE (? IS NULL OR tenant_id=?) ORDER BY id`).all(tenantId, tenantId);
  return rows.map((b) => ({ ...b, zones: db.prepare('SELECT COUNT(*) c FROM zones WHERE store_id=?').get(b.id).c }));
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
/** Owner sets an explicit per-item price for a tier (0/absent branch = all branches). */
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
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT last_number, prefix FROM zones WHERE id=?').get(zoneId);
    const next = cur.last_number + 1;
    db.prepare('UPDATE zones SET last_number=? WHERE id=?').run(next, zoneId);
    const tinfo = db.prepare(
      `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(zone.store_id, zoneId, next, code(cur.prefix, next), 1, lineUserId, label);
    const oinfo = db.prepare('INSERT INTO orders (ticket_id, total, source, branch_id, created_by, channel_id) VALUES (?,?,?,?,?,?)')
      .run(tinfo.lastInsertRowid, total, source, zone.store_id, actorId, channelId);
    const ins = db.prepare('INSERT INTO order_items (order_id, name, price, qty, kind) VALUES (?,?,?,?,?)');
    for (const it of lines) ins.run(oinfo.lastInsertRowid, it.name, it.price, it.qty, toppingNames.has(it.name) ? 'addon' : 'base');
    logSaleEvent({ branchId: zone.store_id, ticketId: tinfo.lastInsertRowid, orderId: oinfo.lastInsertRowid, type: 'order_created', amount: total, actor: actorId, meta: { source } });
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id=?').get(tinfo.lastInsertRowid), total };
  });
  const r = tx();

  // Remember this LINE customer for next-visit reorder suggestions (best-effort).
  if (source === 'customer' && lineUserId) recordCustomerOrder(lineUserId, customerName);

  // Confirmation push for customer self-orders (queue number + amount to pay at counter).
  if (source === 'customer' && lineUserId) {
    const ahead = aheadCount(r.ticket);
    pushQueue(lineUserId,
      `🎫 รับออเดอร์แล้ว\n` +
      `หมายเลขคิวของคุณ: ${r.ticket.code}\n` +
      `คิวรอก่อนหน้า: ${ahead}\n` +
      `💵 กรุณาชำระเงิน ฿${r.total} ที่เคาน์เตอร์\n` +
      `เราจะแจ้งเตือนเมื่อเครื่องดื่มพร้อมค่ะ`,
      queueLink(zoneId), 'ดูคิวของฉัน');
  }
  return r;
}

/** Cashier marks a ticket's order paid (collected cash / PromptPay at the counter).
 *  opts.actorId = staff who took payment; opts.method = cash|promptpay|slip|other. */
export function setOrderPaid(ticketId, opts = {}) {
  const { actorId = null, method = null } = opts;
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  db.prepare(`UPDATE orders SET payment_status='paid', paid_at=datetime('now'), paid_by=?, payment_method=COALESCE(?, payment_method) WHERE id=?`)
    .run(actorId, method, order.id);
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'paid', amount: order.total, actor: actorId, meta: { method: method || 'cash' } });
  return { ok: true, ticketId: Number(ticketId), total: order.total };
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

/** Cashier cancels/voids a ticket and its order (customer changed their mind, etc.).
 *  opts.actorId = staff; opts.reason = free text. void_kind auto: 'refund' if the order
 *  was already paid, else 'void'. */
export function cancelOrderTicket(ticketId, threshold, opts = {}) {
  const { actorId = null, reason = null } = opts;
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  const kind = order && order.payment_status === 'paid' ? 'refund' : 'void';
  // Void/refund: mark the order void (even if it was already paid -> a refund) so it
  // drops out of the report and its revenue is deducted from sales.
  db.prepare(`UPDATE orders SET payment_status='void', void_kind=?, void_reason=?, voided_at=datetime('now'), voided_by=? WHERE ticket_id=?`)
    .run(kind, reason, actorId, ticketId);
  if (order) logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: kind, amount: order.total, actor: actorId, meta: { reason } });
  db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(ticketId);
  if (t.line_user_id) {
    pushQueue(t.line_user_id,
      `❌ ออเดอร์ ${t.code} ถูกยกเลิกโดยร้านค่ะ\n` +
      `หากมีข้อสงสัย กรุณาสอบถามพนักงาน ขอบคุณค่ะ`, null);
  }
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return { ok: true };
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
  return { total: order.total, discount: order.discount || 0, items: rows, lines, payment_status: order.payment_status || 'unpaid', source: order.source || 'cashier' };
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
  if (!reveal) { waiting.forEach((t) => { t.customer_name = maskName(t.customer_name); });
                 recentCalled.forEach((t) => { t.customer_name = maskName(t.customer_name); }); }
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
    }
    return t;
  };
  waiting.forEach(attach); recentCalled.forEach(attach);
  return { zone, waiting, recentCalled, waitingCount: waiting.length };
}

export function ticketView(ticketId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) return null;
  const zone = getZone(t.zone_id);
  const o = orderForTicket(t.id);
  return {
    id: t.id, code: t.code, status: t.status, party_size: t.party_size, rating: t.rating,
    zone: zone.name, ahead: t.status === 'waiting' ? aheadCount(t) : 0,
    last_called: zone.last_called ? `${zone.prefix}${pad(zone.last_called)}` : null,
    order: o ? { total: o.total, items: o.items, lines: o.lines, paid: o.payment_status === 'paid', status: o.payment_status } : null,
  };
}

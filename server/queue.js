import { db, getSetting, setSetting } from './db.js';
import { pushQueue } from './line.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;

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
    `🎫 Queue confirmed\n` +
    `Your number: ${ticket.code}\n` +
    `Groups ahead: ${ahead}\n` +
    `We'll notify you here on LINE when you're up soon.`,
    queueLink(zoneId));

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
    `🔔 It's your turn!\n` +
    `Number: ${next.code}\n` +
    `Please come to the counter.`,
    queueLink(zoneId));

  evaluateSoonNotifications(zoneId, threshold);
  return { called: next };
}

/** Mark a called ticket served, or skip / cancel any ticket. */
export function setStatus(ticketId, status, threshold) {
  const allowed = ['served', 'skipped', 'cancelled', 'no_show'];
  if (!allowed.includes(status)) throw new Error('bad_status');
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  db.prepare(`UPDATE tickets SET status=?, closed_at=datetime('now') WHERE id=?`).run(status, ticketId);
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
        `⏰ You're up soon!\n` +
        `Number: ${t.code}\n` +
        `Groups ahead: ${ahead}\n` +
        `Please head back to the store.`,
        queueLink(zoneId));
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
export function getFinanceSettings() {
  const out = {};
  for (const [key, [envKey, def]] of Object.entries(FIN_KEYS)) {
    const stored = getSetting('fin_' + key, null);
    const envVal = process.env[envKey];
    const val = stored != null ? stored : (envVal != null ? envVal : def);
    out[key] = Number(val);
    if (!Number.isFinite(out[key])) out[key] = Number(def);
  }
  return out;
}
export function setFinanceSettings(patch = {}) {
  for (const key of Object.keys(FIN_KEYS)) {
    if (patch[key] != null && patch[key] !== '') {
      const n = Math.max(0, Number(patch[key]));
      if (Number.isFinite(n)) setSetting('fin_' + key, n);
    }
  }
  return getFinanceSettings();
}

/** Daily report: cups sold, no-shows, avg wait, avg rating + per-zone, since the last reset. */
export function dailyReport() {
  const perZone = db.prepare(
    `SELECT z.id, z.name, z.prefix, z.last_number AS issued,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served')  AS served,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show') AS no_shows
     FROM zones z ORDER BY z.id`
  ).all();
  const cupsSold = perZone.reduce((s, z) => s + z.served, 0);
  const issued = perZone.reduce((s, z) => s + z.issued, 0);
  const noShows = perZone.reduce((s, z) => s + z.no_shows, 0);
  const wait = db.prepare(
    `SELECT AVG((julianday(called_at)-julianday(created_at))*86400) AS s
     FROM tickets WHERE called_at IS NOT NULL`
  ).get();
  const rating = db.prepare(
    `SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM tickets WHERE rating IS NOT NULL`
  ).get();
  // Item sales tagged drink/topping via the menu (so we can split the P&L and count cups).
  const itemSales = db.prepare(
    `SELECT oi.name,
            COALESCE(mi.category,'drink') AS category,
            SUM(oi.qty) AS qty,
            SUM(oi.qty*oi.price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.name = oi.name
     GROUP BY oi.name ORDER BY revenue DESC`
  ).all();
  const revenue = itemSales.reduce((s, i) => s + (i.revenue || 0), 0);
  itemSales.forEach((i) => { i.pct = revenue ? i.revenue / revenue : 0; });
  const drinkSales = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.revenue, 0);
  const toppingSales = revenue - drinkSales;
  const cups = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.qty, 0);

  // P&L from the financial settings (today's sales vs prorated daily fixed costs).
  const f = getFinanceSettings();
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
    cupsSold, issued, noShows, revenue,
    avgWaitMin: wait.s != null ? Math.round((wait.s / 60) * 10) / 10 : null,
    avgRating: rating.avg != null ? Math.round(rating.avg * 10) / 10 : null,
    ratingCount: rating.n,
    itemSales, perZone, pnl, settings: f,
  };
}

/** Daily reset: clear all tickets and restart numbering from 0 in every zone. */
export function resetAllZones() {
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
export function listMenu() {
  return db.prepare('SELECT id, name, name_en, price, image, category, active, soldout, sort FROM menu_items ORDER BY sort, id').all();
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

// ---------- Orders: tie a quick-service order to a fresh queue number ----------
/**
 * Create an order + a fresh queue number in one transaction.
 * opts.source: 'cashier' (default) or 'customer' (self-ordered via the LINE app).
 * opts.lineUserId / opts.customerName: tie the ticket to a LINE customer so they can
 * resume it and receive pushes. Customer self-orders are deduped (one open order each).
 */
export function createOrder(zoneId, items, opts = {}) {
  const { source = 'cashier', lineUserId = null, customerName = null } = opts;
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
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT last_number, prefix FROM zones WHERE id=?').get(zoneId);
    const next = cur.last_number + 1;
    db.prepare('UPDATE zones SET last_number=? WHERE id=?').run(next, zoneId);
    const tinfo = db.prepare(
      `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(zone.store_id, zoneId, next, code(cur.prefix, next), 1, lineUserId, label);
    const oinfo = db.prepare('INSERT INTO orders (ticket_id, total, source) VALUES (?,?,?)')
      .run(tinfo.lastInsertRowid, total, source);
    const ins = db.prepare('INSERT INTO order_items (order_id, name, price, qty) VALUES (?,?,?,?)');
    for (const it of lines) ins.run(oinfo.lastInsertRowid, it.name, it.price, it.qty);
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id=?').get(tinfo.lastInsertRowid), total };
  });
  const r = tx();

  // Confirmation push for customer self-orders (queue number + amount to pay at counter).
  if (source === 'customer' && lineUserId) {
    const ahead = aheadCount(r.ticket);
    pushQueue(lineUserId,
      `🎫 Order received\n` +
      `Your number: ${r.ticket.code}\n` +
      `Groups ahead: ${ahead}\n` +
      `💵 Please pay ฿${r.total} at the counter.\n` +
      `We'll notify you here when it's ready.`,
      queueLink(zoneId));
  }
  return r;
}

/** Cashier marks a ticket's order paid (collected cash / PromptPay at the counter). */
export function setOrderPaid(ticketId) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  db.prepare(`UPDATE orders SET payment_status='paid', paid_at=datetime('now') WHERE id=?`).run(order.id);
  return { ok: true, ticketId: Number(ticketId), total: order.total };
}

/** Cashier cancels/voids a ticket and its order (customer changed their mind, etc.). */
export function cancelOrderTicket(ticketId, threshold) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  db.prepare(`UPDATE orders SET payment_status='void' WHERE ticket_id=? AND payment_status!='paid'`).run(ticketId);
  db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(ticketId);
  if (t.line_user_id) {
    pushQueue(t.line_user_id,
      `❌ Order ${t.code} was cancelled by the store.\n` +
      `If this is a mistake, please ask our staff. Thank you!`, null);
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
  return { total: order.total, items: rows, lines, payment_status: order.payment_status || 'unpaid', source: order.source || 'cashier' };
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
    order: o ? { total: o.total, items: o.items, lines: o.lines, paid: o.payment_status === 'paid' } : null,
  };
}

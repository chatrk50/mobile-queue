// UAT-ONLY realistic sales simulation. Populates weeks of orders, customers, ratings, loyalty,
// cash rounds (with reconciliation), stock, suppliers and a couple of coupons so EVERY report,
// chart and reconciliation on the sandbox has real-looking data to verify against.
//
// SAFETY: only ever called from index.js's `!DURABLE` boot block, so prod (durable Turso) can NEVER
// receive fake data. Idempotent — skips when orders already exist. Deterministic (seeded RNG) so
// the numbers look the same on every UAT boot. Regenerates after a redeploy/restart, so it is not
// "removed" — the owner keeps a stable simulated dataset to test with.
import { db } from '../server/db.js';
import { archiveTodaySales, setFinanceSettings } from '../server/queue.js';

// --- deterministic RNG (mulberry32) so the sandbox is stable across boots ---
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(20260724);
const rnd = (a, b) => a + rng() * (b - a);
const ri = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
// Weighted pick: [[value, weight], …]
function wpick(pairs) { const tot = pairs.reduce((s, p) => s + p[1], 0); let x = rng() * tot; for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; } return pairs[0][0]; }

// A UTC 'YYYY-MM-DD HH:MM:SS' string for a Bangkok-local time `daysAgo` days back at hh:mm.
function bkkTs(daysAgo, hh, mm, ss = null) {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  bkk.setUTCDate(bkk.getUTCDate() - daysAgo);
  bkk.setUTCHours(hh, mm, ss == null ? ri(0, 59) : ss, 0);
  return new Date(bkk.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
function bkkDate(daysAgo) {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  bkk.setUTCDate(bkk.getUTCDate() - daysAgo);
  return bkk.toISOString().slice(0, 10);
}
const hexId = () => 'U' + Array.from({ length: 32 }, () => '0123456789abcdef'[ri(0, 15)]).join('');
const r2 = (n) => Math.round(n * 100) / 100;

const TENDERS = [['cash', 46], ['promptpay', 30], ['kplus', 12], ['6040', 7], ['online', 5]];
const THAI_NAMES = ['เมย์', 'ฟ้า', 'ไอซ์', 'มิ้นท์', 'บีม', 'ปอนด์', 'แนน', 'จีจี้', 'ตูน', 'พลอย', 'อ้อม', 'กัน', 'นิว', 'เจ', 'แพร', 'มายด์', 'ปิ่น', 'เบนซ์', 'หนึ่ง', 'ข้าวฟ่าง', 'ตาล', 'ครีม', 'หมิว', 'โบว์', 'เอิร์ธ', 'ฟิล์ม', 'น้ำ', 'ดาว', 'ใบเฟิร์น', 'ต้นข้าว'];

export function seedMockData() {
  const already = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  if (already > 0) return { seeded: false, reason: 'orders_exist' };
  const store = db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get();
  if (!store) return { seeded: false, reason: 'no_store' };
  const storeId = store.id, BR = 1;
  const zones = db.prepare('SELECT id, prefix FROM zones WHERE store_id=? ORDER BY id').all(storeId);
  const drinks = db.prepare("SELECT id, name, price FROM menu_items WHERE category='drink' AND active=1").all();
  const toppings = db.prepare("SELECT id, name, price FROM menu_items WHERE category='topping' AND active=1").all();
  if (!drinks.length || !zones.length) return { seeded: false, reason: 'no_menu' };

  const insTicket = db.prepare(`INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, customer_key, status, rating, numbered_at, created_at, called_at, closed_at)
    VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?)`);
  const insOrder = db.prepare(`INSERT INTO orders (ticket_id, total, source, payment_status, payment_method, discount, void_kind, voided_at, paid_at, created_at, branch_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insItem = db.prepare('INSERT INTO order_items (order_id, name, price, qty, kind) VALUES (?,?,?,?,?)');

  // ---------- Customers (mix of LINE + walk-in phone, varied recency/frequency) ----------
  const custs = [];
  db.transaction(() => {
    for (let i = 0; i < 46; i++) {
      const isLine = i < 32;                                   // 32 LINE-reachable, 14 phone-only
      const key = isLine ? hexId() : ('tel:08' + Array.from({ length: 8 }, () => ri(0, 9)).join(''));
      const name = pick(THAI_NAMES) + (chance(0.3) ? ' ' + String.fromCharCode(0x0e01 + ri(0, 40)) : '');
      const birthday = chance(0.4) ? `19${ri(85, 99)}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}` : null;
      db.prepare('INSERT OR IGNORE INTO customers (line_user_id, name, first_seen, birthday, points, lifetime_points, order_count, consent_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(key, name, bkkTs(ri(30, 120), 12, 0), birthday, 0, 0, 0, isLine ? bkkTs(ri(1, 60), 12, 0) : null);
      // frequency profile → drives CRM segments (regular / at_risk / lost / new)
      const profile = wpick([['regular', 34], ['at_risk', 18], ['lost', 16], ['new', 32]]);
      custs.push({ key, name, isLine, profile, points: 0, lifetime: 0 });
    }
  })();

  // ---------- Order emitter (one paid/void order for an optional customer, at a given day) ----------
  let orderCount = 0, ratingCount = 0;
  const seq = {}; zones.forEach((z) => (seq[z.id] = 0));
  function emit(cust, d, hh, mm, { forceOk = false } = {}) {
    const ts = bkkTs(d, hh, mm), zone = pick(zones);
    const nLines = wpick([[1, 62], [2, 30], [3, 8]]);
    const lines = []; let gross = 0;
    for (let l = 0; l < nLines; l++) {
      const dr = pick(drinks); const qty = wpick([[1, 84], [2, 14], [3, 2]]);
      const sweet = pick([0, 25, 50, 100, 100, 100, 125]);
      lines.push({ name: dr.name + (sweet !== 100 ? ` · หวาน ${sweet}%` : ''), price: dr.price, qty, kind: 'base' }); gross += dr.price * qty;
      if (chance(0.28)) { const tp = pick(toppings); lines.push({ name: tp.name, price: tp.price, qty: 1, kind: 'addon' }); gross += tp.price; }
    }
    const discount = chance(0.08) ? pick([10, 20, 20, 49]) : 0;
    const method = wpick(TENDERS);
    const roll = rng();
    let payStatus = 'paid', voidKind = null, voidedAt = null;
    if (!forceOk && roll < 0.02) { payStatus = 'void'; voidKind = 'waste'; voidedAt = bkkTs(d, hh, mm + 2); }
    else if (!forceOk && roll < 0.06) { payStatus = 'void'; voidKind = chance(0.5) ? 'refund' : 'void'; voidedAt = bkkTs(d, hh, mm + 3); }
    const rating = (payStatus === 'paid' && cust && chance(0.4)) ? wpick([[5, 52], [4, 30], [3, 12], [2, 4], [1, 2]]) : null;
    const code = zone.prefix + String(++seq[zone.id]).padStart(3, '0');
    const tid = insTicket.run(storeId, zone.id, seq[zone.id], code, cust ? cust.key : null, cust ? cust.name : null, cust ? cust.key : null,
      payStatus === 'void' && voidKind !== 'refund' ? 'cancelled' : 'served', rating, ts, ts, bkkTs(d, hh, mm + 1), bkkTs(d, hh, mm + 5)).lastInsertRowid;
    const oid = insOrder.run(tid, r2(gross), cust && cust.isLine ? 'customer' : 'cashier', payStatus, method, discount, voidKind, voidedAt, ts, ts, BR).lastInsertRowid;
    for (const ln of lines) insItem.run(oid, ln.name, ln.price, ln.qty, ln.kind);
    orderCount++; if (rating) ratingCount++;
    if (payStatus === 'paid' && cust && cust.isLine) {
      const cups = lines.filter((l) => l.kind === 'base').reduce((s, l) => s + l.qty, 0);
      cust.points += cups; cust.lifetime += cups;
      db.prepare("INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note, at) VALUES (?,?,?,?,?,?)").run(cust.key, 'earn', cups, oid, 'สะสมจากออเดอร์', ts);
    }
    if (payStatus === 'paid' && cust) db.prepare('UPDATE customers SET last_order_at=MAX(COALESCE(last_order_at,?),?), order_count=order_count+1 WHERE line_user_id=?').run(ts, ts, cust.key);
  }
  const dayPart = () => wpick([[[10, 13], 26], [[13, 16], 22], [[16, 19], 34], [[19, 21], 18]]);
  // Recent 28 days: walk-ins + REGULAR customers only (so their many recent visits → 'regular').
  const regulars = custs.filter((c) => c.profile === 'regular');
  for (let d = 28; d >= 0; d--) {
    const dow = new Date(Date.now() + 7 * 3600 * 1000 - d * 86400000).getUTCDay();
    const busy = (dow === 0 || dow === 6) ? 1.5 : (dow === 5 ? 1.25 : 1);
    const nOrders = d === 0 ? ri(6, 16) : Math.round(ri(18, 34) * busy);
    db.transaction(() => {
      for (let k = 0; k < nOrders; k++) {
        const [h0, h1] = dayPart();
        const cust = chance(0.6) ? pick(regulars) : null;
        emit(cust, d, ri(h0, h1 - 1), ri(0, 59));
      }
    })();
  }
  // Give each segment a genuine last-visit age so CRM shows new / at_risk / lost, not just regular.
  db.transaction(() => {
    for (const c of custs) {
      if (c.profile === 'new') emit(c, ri(1, 18), 14, ri(0, 59), { forceOk: true });                 // 1 recent visit
      else if (c.profile === 'at_risk') for (let n = ri(2, 3); n > 0; n--) emit(c, ri(33, 55), 15, ri(0, 59), { forceOk: true });  // last visit 31–60d
      else if (c.profile === 'lost') for (let n = 2; n > 0; n--) emit(c, ri(66, 120), 13, ri(0, 59), { forceOk: true });           // last visit >60d
    }
  })();
  db.transaction(() => { for (const c of custs) if (c.isLine) db.prepare('UPDATE customers SET points=?, lifetime_points=? WHERE line_user_id=?').run(c.points % 40, c.lifetime, c.key); })();

  // ---------- Cost assumptions so the P&L shows real COGS/expenses ----------
  try { setFinanceSettings({ ingredientPct: 0.32, packagingPerCup: 2.62, daysPerMonth: 26, rent: 11100, wages: 13520, utilities: 5200, supplies: 800, marketing: 1500, targetRevenue: 150000 }, null); } catch { /* ignore */ }

  // ---------- Daily archive for each PAST day (drives 7-day / weekly / monthly trends) ----------
  for (let d = 28; d >= 1; d--) { try { archiveTodaySales(bkkDate(d)); } catch { /* skip */ } }
  // Synthetic older history so the 12-week + 12-month trend charts are full (no orders needed).
  const insHist = db.prepare(`INSERT OR IGNORE INTO sales_history (date, branch_id, cups, revenue, gross, net, void_orders, void_cups, void_amount, issued, served, no_shows, drink_sales, topping_sales, cogs, opex, waste_cost)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let d = 29; d <= 300; d++) {
      const dow = new Date(Date.now() + 7 * 3600 * 1000 - d * 86400000).getUTCDay();
      if (dow === 1) continue;                                   // shop closed Mondays (a realistic gap)
      const cups = ri(70, 150), avg = rnd(48, 58);
      const revenue = r2(cups * avg), cogs = r2(revenue * 0.34), opex = 1150;
      insHist.run(bkkDate(d), BR, cups, revenue, revenue, r2(revenue - cogs - opex), ri(0, 3), ri(0, 4), r2(rnd(0, 200)), cups + ri(0, 6), cups, ri(0, 4), r2(revenue * 0.9), r2(revenue * 0.1), cogs, opex, r2(rnd(0, 80)));
    }
  })();

  // ---------- Cash rounds (one closed round per past day; a few reconciled) ----------
  try { seedCashRounds(BR); } catch (e) { console.error('[mock] cash rounds skipped:', e.message); }
  // ---------- Stock, suppliers, POs, recipes ----------
  try { seedStock(storeId, drinks); } catch (e) { console.error('[mock] stock skipped:', e.message); }
  // ---------- A couple of sample coupons ----------
  try { seedCoupons(); } catch (e) { console.error('[mock] coupons skipped:', e.message); }

  return { seeded: true, orders: orderCount, customers: custs.length, ratings: ratingCount };
}

// One closed cash round per past day: expected from that day's cash sales, counted ≈ expected with
// a small realistic variance, and the last few carry a saved tender reconciliation.
function seedCashRounds(BR) {
  const cashByDay = db.prepare(`SELECT date(paid_at,'+7 hours') d, COALESCE(SUM(total-COALESCE(discount,0)),0) v
    FROM orders WHERE payment_status='paid' AND payment_method='cash' AND branch_id=? GROUP BY d`).all(BR);
  const map = {}; for (const r of cashByDay) map[r.d] = r.v;
  for (let d = 21; d >= 1; d--) {
    const day = bkkDate(d), cash = r2(map[day] || 0);
    const float = 500, expected = r2(float + cash);
    const variance = pick([0, 0, 0, 0, 20, -20, 5, -10, 40]);
    const counted = r2(expected + variance);
    const opened = bkkTs(d, 9, 30), closed = bkkTs(d, 21, 0);
    const recon = d <= 4 ? JSON.stringify({ promptpay: { actual: null }, by: 'Owner', at: bkkTs(d, 21, 5) }) : null;
    db.prepare(`INSERT INTO cash_sessions (branch_id, opened_by, opened_at, open_float, closed_by, closed_at, counted_cash, expected_cash, over_short, note, recon_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(BR, null, opened, float, null, closed, counted, expected, r2(counted - expected), variance === 0 ? 'พอดี' : null, recon);
    if (chance(0.4)) db.prepare("INSERT INTO cash_moves (branch_id, kind, amount, remark, at) VALUES (?,?,?,?,?)").run(BR, 'pay_out', pick([80, 120, 200, 60]), pick(['ซื้อน้ำแข็ง', 'ซื้อถุง', 'ค่าน้ำดื่ม', 'ซื้อหลอด']), bkkTs(d, 15, 0));
  }
}

// Ingredients with a purchase + usage history so purchase-planning, low-stock, near-expiry, price
// history and per-menu margins all have something real to show.
function seedStock(storeId, drinks) {
  const ings = [
    ['นมโยเกิร์ต', 'ลิตร', 12, 60, 8], ['น้ำเชื่อมเข้มข้น (มิตรผล)', 'ขวด', 2, 45, 4], ['คิทแคท', 'ถุง', 0, 85, 3],
    ['มะม่วงน้ำดอกไม้', 'กก.', 1, 70, 3], ['สตรอเบอร์รี่แช่แข็ง', 'กก.', 0, 120, 2], ['โอริโอ้', 'ถุง', 6, 55, 4],
    ['ข้าวเหนียวนิล', 'กก.', 4, 40, 2], ['บัวลอย', 'ถุง', 9, 30, 4], ['น้ำผึ้ง', 'ขวด', 3, 95, 2],
    ['แก้ว 16 oz', 'ลอต', 3, 165, 2], ['ฝาโดม', 'ลอต', 5, 90, 2], ['หลอด', 'กล่อง', 7, 45, 3],
  ];
  const ids = [];
  db.transaction(() => {
    for (const [name, unit, stock, cost, low] of ings) {
      const id = db.prepare('INSERT INTO ingredients (name, unit, stock_qty, avg_cost, low_threshold) VALUES (?,?,?,?,?)').run(name, unit, stock, cost, low).lastInsertRowid;
      ids.push({ id, name, unit, cost });
    }
  })();
  const sup = db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?,?,?)').run('แม็คโคร สาขาสาทร', '021234567', 'ส่งอังคาร/ศุกร์').lastInsertRowid;
  const sup2 = db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?,?,?)').run('ตลาดไท (ผลไม้)', '0891112222', 'รับเองทุกเช้า').lastInsertRowid;
  // purchase + usage moves across recent weeks → burn-rate + price history
  const insMove = db.prepare('INSERT INTO stock_moves (ingredient_id, kind, qty, cost, note, supplier_id, expiry, at) VALUES (?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const ing of ids) {
      // two purchases at slightly different prices (→ price history)
      insMove.run(ing.id, 'purchase', ri(10, 24), r2(ing.cost * ri(10, 24) * rnd(0.95, 1.02)), 'สั่งซื้อ', sup, null, bkkTs(20, 10, 0));
      insMove.run(ing.id, 'purchase', ri(10, 24), r2(ing.cost * ri(10, 24) * rnd(0.98, 1.08)), 'สั่งซื้อ', sup, null, bkkTs(9, 10, 0));
      // daily usage (drives burn rate / suggested reorder)
      for (let d = 14; d >= 1; d--) insMove.run(ing.id, 'use', -r2(rnd(0.5, 2.5)), null, 'เบิกใช้', null, null, bkkTs(d, 20, 30));
      if (chance(0.3)) insMove.run(ing.id, 'waste', -r2(rnd(0.2, 1)), null, 'ของเสีย', null, null, bkkTs(ri(1, 6), 20, 40));
    }
    // near-expiry + expired lots (→ ⏳ alerts)
    insMove.run(ids[0].id, 'purchase', 6, 360, 'ล็อตใกล้หมดอายุ', sup2, bkkDate(-3), bkkTs(2, 9, 0));
    insMove.run(ids[3].id, 'purchase', 4, 280, 'ล็อตเลยกำหนด', sup2, bkkDate(2), bkkTs(4, 9, 0));
  })();
  // one received PO + one draft PO
  const poR = db.prepare("INSERT INTO purchase_orders (branch_id, po_no, supplier_id, status, note, ordered_at, received_at) VALUES (1,?,?,?,?,?,?)")
    .run('PO-MOCK-0001', sup, 'received', 'รับของแล้ว', bkkTs(6, 10, 0), bkkTs(5, 11, 0)).lastInsertRowid;
  const poD = db.prepare("INSERT INTO purchase_orders (branch_id, po_no, supplier_id, status, note, ordered_at) VALUES (1,?,?,?,?,?)")
    .run('PO-MOCK-0002', sup, 'draft', 'ร่างจากคำแนะนำ', bkkTs(0, 9, 0)).lastInsertRowid;
  const insPoLine = db.prepare('INSERT INTO purchase_order_lines (po_id, ingredient_id, qty, unit_price) VALUES (?,?,?,?)');
  ids.slice(0, 4).forEach((ing) => insPoLine.run(poR, ing.id, ri(10, 20), ing.cost));
  ids.filter((i) => ['คิทแคท', 'มะม่วงน้ำดอกไม้', 'สตรอเบอร์รี่แช่แข็ง', 'น้ำเชื่อมเข้มข้น (มิตรผล)'].includes(i.name)).forEach((ing) => insPoLine.run(poD, ing.id, ri(8, 16), ing.cost));
  // recipes (BOM) on a handful of drinks so per-menu margin computes
  const byName = Object.fromEntries(ids.map((i) => [i.name, i.id]));
  const insR = db.prepare('INSERT OR IGNORE INTO recipes (menu_item_id, ingredient_id, qty) VALUES (?,?,?)');
  db.transaction(() => {
    for (const dr of drinks) {
      insR.run(dr.id, byName['นมโยเกิร์ต'], 0.18);
      insR.run(dr.id, byName['แก้ว 16 oz'], 1); insR.run(dr.id, byName['ฝาโดม'], 1); insR.run(dr.id, byName['หลอด'], 1);
      if (/คิทแคท/.test(dr.name)) insR.run(dr.id, byName['คิทแคท'], 0.2);
      if (/มะม่วง/.test(dr.name)) insR.run(dr.id, byName['มะม่วงน้ำดอกไม้'], 0.12);
      if (/สตรอ/.test(dr.name)) insR.run(dr.id, byName['สตรอเบอร์รี่แช่แข็ง'], 0.1);
      if (/โอริโอ/.test(dr.name)) insR.run(dr.id, byName['โอริโอ้'], 0.15);
      if (/ข้าวเหนียว/.test(dr.name)) insR.run(dr.id, byName['ข้าวเหนียวนิล'], 0.1);
    }
  })();
}

function seedCoupons() {
  const ins = db.prepare(`INSERT INTO coupons (code, label, disc_type, disc_value, max_disc, min_spend, valid_from, expires_at, usage_limit, per_customer, audience, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`);
  ins.run('WELCOME20', 'ลด 20 บาท ต้อนรับ', 'baht', 20, 0, 0, null, null, 0, 1, 'new');
  ins.run('SAVE10', 'ลด 10% สูงสุด 30', 'percent', 10, 30, 100, null, null, 200, 0, 'all');
  ins.run('SUMMER50', 'ลด 50 บาท (ยอด 150+)', 'baht', 50, 0, 150, bkkDate(-7), bkkDate(30), 100, 1, 'all');
}

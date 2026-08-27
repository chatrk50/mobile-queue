import { createHash } from 'crypto';
import { db, getSetting, setSetting, DURABLE, reconnectDb } from './db.js';
import { pushQueue, pushText, pushStage, pushSummary, pushCouponFlex, lastPushError, botInfo, friendCheck, webhookInfo, webhookTest, setWebhook, LINE_ENABLED } from './line.js';
import { hashPin, verifyPin } from './auth.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;
// White-label: product unit label in owner/customer LINE messages (แก้ว / ถ้วย / ชิ้น / จาน …).
const UNIT = process.env.BRAND_UNIT || 'แก้ว';

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
/** Link for a message that isn't about one specific ticket (win-back, promos): the first open zone,
 *  falling back to the first zone at all. Without this a campaign went out as PLAIN TEXT — the
 *  'สั่งเลย' label was passed to pushQueue but buildQueueMessage drops the button when the URL is
 *  null, so the customer was told to order with no way back into the app. */
export function defaultZoneId() {
  const z = db.prepare('SELECT id FROM zones WHERE is_open=1 ORDER BY id LIMIT 1').get()
         || db.prepare('SELECT id FROM zones ORDER BY id LIMIT 1').get();
  return z ? z.id : null;
}
export function shopLink() {
  const id = defaultZoneId();
  return id ? queueLink(id) : null;
}

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
  // Also refuse when the branch is closed by its own opening hours (auto-close) or the manual
  // store toggle — the LIFF hides the order button then, but a member-card / deep-link entry
  // could still reach here, so the server is the real gate.
  const store = db.prepare('SELECT * FROM stores WHERE id=?').get(zone.store_id);
  if (store && (store.is_open === 0 || !isStoreOpenRow(store))) throw new Error('store_closed');

  // No duplicate numbers per customer: if they already hold an active ticket in
  // this zone, return it instead of issuing a new one (and skip the extra push).
  if (lineUserId) {
    const existing = findActiveTicket(zoneId, lineUserId);
    if (existing) return { ticket: existing, ahead: aheadCount(existing) };
    // No-show strikes: only the BLOCKED tier loses the queue button. The prepay tier still gets a
    // number — it just has to pay first, which createOrder enforces. Placed AFTER the existing-ticket
    // check so a held ticket is never stranded.
    const ns = noshowStrikes(lineUserId);
    if (ns.blocked) { const e = new Error('noshow_blocked'); e.strikes = ns.strikes; e.limit = ns.blockLimit; throw e; }
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

  // Order-confirmation push removed to conserve the LINE OA monthly message quota — the customer
  // already sees their queue number in the LIFF the moment they order; the 'almost your turn' and
  // 'your turn' pushes (the ones that actually bring them back) still fire.
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

  // Stage depends on payment: an UNPAID call means "come pay" — showing the full stage-3 bar
  // (พร้อมรับ) would then REGRESS to stage 2 when the paid push fires minutes later, which reads
  // as the system going backwards. Paid orders keep the original "ready" presentation.
  const nextOrder = db.prepare(`SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1`).get(next.id);
  const nextPaid = !nextOrder || nextOrder.payment_status === 'paid';
  pushStage(next.line_user_id, nextPaid
    ? { stage: 3, title: 'ถึงคิวของคุณแล้ว!', code: next.code,
        subtitle: 'กรุณามาที่เคาน์เตอร์ค่ะ', link: queueLink(zoneId), label: 'ดูคิวของฉัน' }
    : { stage: 2, title: 'ถึงคิวของคุณแล้ว!', code: next.code,
        subtitle: 'กรุณามาชำระเงินที่เคาน์เตอร์ค่ะ', link: queueLink(zoneId), label: 'ดูคิวของฉัน' }, 'queue');

  evaluateSoonNotifications(zoneId, threshold);
  return { called: next };
}

/** Mark ONE ticket "พร้อมรับ" (ready for pickup) — set status='called' + notify the customer.
 *  Fired when the cashier finishes every drink line (all ✅). Only a PAID order is announced
 *  (never tell a customer to come before they've paid). Idempotent + safe on a closed ticket. */
export function markReady(ticketId, threshold) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (['served', 'cancelled', 'no_show', 'skipped'].includes(t.status)) return { ok: false, status: t.status, zoneId: t.zone_id };
  if (t.status === 'called') return { ok: true, already: true, zoneId: t.zone_id };   // already announced
  const o = orderForTicket(ticketId);
  if (o && o.payment_status !== 'paid') return { ok: false, reason: 'unpaid', zoneId: t.zone_id };   // pay-first: don't announce ready before payment
  db.prepare("UPDATE tickets SET status='called', called_at=datetime('now'), called_count=called_count+1 WHERE id=?").run(ticketId);
  if (t.number > 0) db.prepare('UPDATE zones SET last_called=? WHERE id=?').run(t.number, t.zone_id);
  if (t.line_user_id) pushStage(t.line_user_id, { stage: 3, title: 'เครื่องดื่มพร้อมรับแล้ว!', code: t.code,
    subtitle: 'เชิญรับที่เคาน์เตอร์ได้เลยค่ะ', link: queueLink(t.zone_id), label: 'ดูคิวของฉัน' }, 'queue');
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return { ok: true, zoneId: t.zone_id };
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
      `✅ รับเครื่องดื่มเรียบร้อยแล้ว · หมายเลข ${t.code}\n` +
      `\n` +
      `⭐ รบกวนให้คะแนนร้านหน่อยนะคะ ⭐\n` +
      `👇 แตะปุ่ม "ให้คะแนนร้าน" ด้านล่าง — แค่ 5 วินาที มีความหมายกับร้านมากค่ะ 🙏\n` +
      `\n` +
      `ขอบคุณที่อุดหนุน แล้วพบกันใหม่นะคะ 😊`,
      queueLink(t.zone_id), '⭐ ให้คะแนนร้าน');
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
      pushStage(t.line_user_id, { stage: 2, title: 'ใกล้ถึงคิวของคุณแล้ว!', code: t.code,
        subtitle: `คิวรอก่อนหน้า: ${ahead} · กรุณากลับมาที่ร้านค่ะ`, link: queueLink(zoneId), label: 'ดูคิวของฉัน' }, 'queue');
    }
  });
}

/** Customer rating (1..5) for a served ticket. */
// Quick-reason chips shown under the stars. Two bands, because the same question has an opposite
// meaning at 2 stars and at 5: a low score asks "what went wrong", a high one "what did we do well".
// Slugs are stored (stable), labels are what the customer sees (translatable, editable later).
// The LIFF renders whatever this exports via /api/config, so the customer can never submit a tag
// the server would reject — one vocabulary, one source of truth.
export const RATING_TAGS = {
  low: [
    { id: 'taste', label: 'รสชาติไม่ถูกปาก' },
    { id: 'slow', label: 'รอนาน' },
    { id: 'price', label: 'ราคาแพงไป' },
    { id: 'portion', label: 'ปริมาณน้อย' },
    { id: 'staff', label: 'พนักงานบริการไม่ดี' },
    { id: 'wrong', label: 'ได้ไม่ตรงที่สั่ง' },
  ],
  high: [
    { id: 'taste_good', label: 'อร่อย' },
    { id: 'fast', label: 'รวดเร็ว' },
    { id: 'worth', label: 'ราคาคุ้มค่า' },
    { id: 'fresh', label: 'สดใหม่' },
    { id: 'staff_good', label: 'พนักงานเอาใจใส่' },
    { id: 'clean', label: 'สะอาด' },
  ],
};
/** Which band a score belongs to. 1–3 asks what went wrong, 4–5 what went right. */
export function ratingBand(stars) { return Number(stars) <= 3 ? 'low' : 'high'; }
const RATING_COMMENT_MAX = 500;

export function setRating(ticketId, stars, opts = {}) {
  const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
  const t = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  // Only tags from the band that matches the score survive — a client can't file "อร่อย" under 1 star.
  const allowed = new Set(RATING_TAGS[ratingBand(s)].map((x) => x.id));
  const tags = (Array.isArray(opts.tags) ? opts.tags : [])
    .map((x) => String(x || '').trim())
    .filter((x, i, a) => allowed.has(x) && a.indexOf(x) === i)
    .slice(0, 6);
  const comment = String(opts.comment || '').trim().slice(0, RATING_COMMENT_MAX);
  db.prepare(`UPDATE tickets SET rating = ?, rating_tags = ?, rating_comment = ?, rated_at = datetime('now') WHERE id = ?`)
    .run(s, tags.length ? tags.join(',') : null, comment || null, ticketId);
  return { ok: true, rating: s, tags, comment };
}

/**
 * Owner feedback report: every review in a window, with the reasons behind the score.
 * The star distribution already exists in customerInsights(); this answers the next question —
 * WHY. Tag counts are split by band so "รอนาน ×7" is never averaged against "รวดเร็ว ×20".
 */
export function ratingFeedback({ days = 30, from = null, to = null, limit = 500 } = {}) {
  const d = Math.max(1, Math.min(365, Math.round(Number(days) || 30)));
  const lim = Math.max(1, Math.min(1000, Math.round(Number(limit) || 500)));
  const isDay = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  // An explicit from–to wins over the day count, so the compact range picker (DESIGN-SYSTEM §4)
  // drives this report the same way it drives every other one.
  const custom = isDay(from) && isDay(to) && from <= to;
  const rows = custom
    ? db.prepare(`
    SELECT id, code, rating, rating_tags AS tags, rating_comment AS comment,
           COALESCE(rated_at, created_at) AS at, customer_name AS name
      FROM tickets
     WHERE rating IS NOT NULL
       AND date(COALESCE(rated_at, created_at), '+7 hours') BETWEEN ? AND ?
     ORDER BY COALESCE(rated_at, created_at) DESC
     LIMIT ?`).all(from, to, lim)
    : db.prepare(`
    SELECT id, code, rating, rating_tags AS tags, rating_comment AS comment,
           COALESCE(rated_at, created_at) AS at, customer_name AS name
      FROM tickets
     WHERE rating IS NOT NULL
       AND date(COALESCE(rated_at, created_at), '+7 hours') >= date('now', '+7 hours', ?)
     ORDER BY COALESCE(rated_at, created_at) DESC
     LIMIT ?`).all(`-${d - 1} days`, lim);

  const label = (band, id) => (RATING_TAGS[band].find((x) => x.id === id) || {}).label || id;
  const counts = { low: {}, high: {} };
  // bandN = how many reviews are IN each band. Without it a tag count is unreadable: "อร่อย 3"
  // could be 3 of 3 happy customers or 3 of 300, and the old bar (scaled to the largest tag) drew
  // every equal count as a full bar — which is exactly what made the owner ask "real?".
  const bandN = { low: 0, high: 0 };
  const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0, withComment = 0, withTags = 0;
  const items = rows.map((r) => {
    const band = ratingBand(r.rating);
    const tags = (r.tags || '').split(',').filter(Boolean);
    for (const t of tags) counts[band][t] = (counts[band][t] || 0) + 1;
    bandN[band] += 1;
    if (stars[r.rating] != null) stars[r.rating] += 1;
    sum += r.rating;
    if (r.comment) withComment += 1;
    if (tags.length) withTags += 1;
    return { id: r.id, code: r.code, rating: r.rating, at: r.at, name: r.name || null,
             comment: r.comment || null, tags: tags.map((t) => ({ id: t, label: label(band, t) })) };
  });
  const top = (band) => Object.entries(counts[band])
    .map(([id, n]) => ({ id, label: label(band, id), n, of: bandN[band],
      pct: bandN[band] ? Math.round((n / bandN[band]) * 100) : 0 }))
    .sort((a, b) => b.n - a.n);
  return {
    days: custom ? null : d,
    from: custom ? from : db.prepare("SELECT date('now','+7 hours',?) d").get(`-${d - 1} days`).d,
    to: custom ? to : db.prepare("SELECT date('now','+7 hours') d").get().d,
    count: items.length,
    avg: items.length ? Math.round((sum / items.length) * 10) / 10 : null,
    withComment, withTags, stars, bandN,
    lowTags: top('low'),
    highTags: top('high'),
    items,
  };
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
  // --- Full P&L expense set (owner asked for every line a normal set of accounts carries).
  // All default to 0, so adding them changes NOTHING until the owner fills one in. Monthly ฿
  // unless noted; each is prorated by daysPerMonth exactly like rent/wages already were.
  freight: ['FIN_FREIGHT', 0],                    // COGS: ค่าขนส่ง/ค่าเดินทางไปซื้อวัตถุดิบ (freight-in)
  staffBenefits: ['FIN_STAFF_BENEFITS', 0],       // Payroll: ประกันสังคม/สวัสดิการ/โบนัส
  commonFee: ['FIN_COMMON_FEE', 0],               // Occupancy: ค่าส่วนกลาง/ที่จอดรถ/ค่าเช่าอุปกรณ์
  payFees: ['FIN_PAY_FEES', 0],                   // Selling: ค่าธรรมเนียมรับชำระ (QR/บัตร) — คอมแพลตฟอร์มคิดแยกรายช่องทาง
  repairs: ['FIN_REPAIRS', 0],                    // Other: ซ่อมบำรุง/ทำความสะอาด
  software: ['FIN_SOFTWARE', 0],                  // Other: อินเทอร์เน็ต/โทรศัพท์/ซอฟต์แวร์ (POS, LINE OA)
  insurance: ['FIN_INSURANCE', 0],                // Other: ประกันภัย
  proFees: ['FIN_PRO_FEES', 0],                   // Other: ค่าบัญชี/ค่าธรรมเนียมธนาคาร
  licenses: ['FIN_LICENSES', 0],                  // Other: ภาษีป้าย/ใบอนุญาต/ค่าธรรมเนียมราชการ
  depreciation: ['FIN_DEPRECIATION', 0],          // below EBITDA: ค่าเสื่อมราคาอุปกรณ์/ตกแต่ง
  interest: ['FIN_INTEREST', 0],                  // below EBIT: ดอกเบี้ยจ่ายเงินกู้
  taxPct: ['FIN_TAX_PCT', 0],                     // 0.20 = 20% ภาษีเงินได้ (คิดเฉพาะเมื่อกำไรก่อนภาษี > 0)
};
// Operating-expense lines grouped the way an accountant reads a P&L. Anything NOT here
// (depreciation / interest / tax) sits BELOW the operating line on purpose.
export const OPEX_GROUPS = [
  ['payroll',   'บุคลากร',            ['wages', 'staffBenefits']],
  ['occupancy', 'สถานที่',            ['rent', 'utilities', 'commonFee']],
  ['selling',   'การขาย / การตลาด',   ['marketing', 'payFees']],
  ['other',     'ดำเนินงานอื่น ๆ',    ['supplies', 'repairs', 'software', 'insurance', 'proFees', 'licenses']],
];
export const FIN_LABELS = {
  ingredientPct: 'วัตถุดิบ % ของยอดขาย', packagingPerCup: 'แพ็กเกจ ฿/แก้ว', freight: 'ค่าขนส่งวัตถุดิบ',
  daysPerMonth: 'วันขาย / เดือน', targetRevenue: 'เป้ายอดขาย / เดือน',
  wages: 'ค่าแรงพนักงาน', staffBenefits: 'ประกันสังคม / สวัสดิการ / โบนัส',
  rent: 'ค่าเช่าที่', utilities: 'ค่าไฟ / ค่าน้ำ / น้ำแข็ง', commonFee: 'ค่าส่วนกลาง / เช่าอุปกรณ์',
  marketing: 'การตลาด / โฆษณา', payFees: 'ค่าธรรมเนียมรับชำระ (QR/บัตร)',
  supplies: 'วัสดุสิ้นเปลือง', repairs: 'ซ่อมบำรุง / ทำความสะอาด', software: 'เน็ต / โทรศัพท์ / ซอฟต์แวร์',
  insurance: 'ประกันภัย', proFees: 'ค่าบัญชี / ค่าธรรมเนียมธนาคาร', licenses: 'ภาษีป้าย / ใบอนุญาต',
  depreciation: 'ค่าเสื่อมราคาอุปกรณ์', interest: 'ดอกเบี้ยจ่าย', taxPct: 'ภาษีเงินได้ %',
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

/** Public star rating for the customer-facing home: all-time average of real ticket reviews.
 *  Deliberately tiny (avg + count only) — safe to expose in /api/config as social proof. */
export function publicRating() {
  const r = db.prepare('SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM tickets WHERE rating IS NOT NULL').get();
  return { avg: r.n ? Math.round(r.avg * 10) / 10 : null, count: r.n || 0 };
}
/** Customer satisfaction (star distribution) + repeat-buyer stats (returning LINE customers). */
export function customerInsights() {
  const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let total = 0, sum = 0;
  for (const r of db.prepare('SELECT rating, COUNT(*) n FROM tickets WHERE rating IS NOT NULL GROUP BY rating').all()) {
    if (stars[r.rating] != null) { stars[r.rating] = r.n; total += r.n; sum += r.rating * r.n; }
  }
  // Compute the customer base from ACTUAL paid orders, unified across LINE (line_user_id) and phone
  // (customer_key) — so phone customers count too, not just LINE. Visits/spend are real, not the
  // LINE-only maintained order_count.
  const rows = db.prepare(
    `SELECT COALESCE(t.line_user_id, t.customer_key) AS k,
            COUNT(DISTINCT t.id) AS visits,
            COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS spend,
            MAX(o.paid_at) AS last_paid
     FROM tickets t JOIN orders o ON o.ticket_id=t.id
     WHERE o.payment_status='paid' AND COALESCE(t.line_user_id, t.customer_key) IS NOT NULL
     GROUP BY k`
  ).all();
  const totalC = rows.length;
  const repeatC = rows.filter((r) => r.visits >= 2).length;
  const nameOf = (k) => (db.prepare('SELECT name FROM customers WHERE line_user_id=?').get(k)?.name) || null;
  const top = rows.filter((r) => r.visits >= 2)
    .sort((a, b) => b.visits - a.visits || String(b.last_paid || '').localeCompare(String(a.last_paid || '')))
    .slice(0, 10)
    .map((r) => ({
      name: nameOf(r.k) || (String(r.k).startsWith('tel:') ? r.k.slice(4) : 'ลูกค้า LINE'),
      isPhone: String(r.k).startsWith('tel:'),
      order_count: r.visits,
      spend: Math.round((r.spend || 0) * 100) / 100,
      last_order_at: r.last_paid,
    }));
  return {
    satisfaction: { avg: total ? Math.round((sum / total) * 10) / 10 : null, total, stars },
    customers: { total: totalC, repeat: repeatC, repeatPct: totalC ? Math.round((repeatC / totalC) * 100) : 0, top },
  };
}

// ---- CRM: win-back (re-engage lapsed LINE customers) ----
/** LINE customers (real userId, not a 'tel:' phone key) whose most recent PAID order is at least
 *  `days` days ago — i.e. they've gone quiet. Newest-lapsed first. Phone-only customers can't be
 *  LINE-messaged, so they're excluded here. */
/** LINE push volume — the OA bills by message count, so the owner needs to SEE the monthly volume.
 *  Counts real sends only (the UAT stub never logs). */
export function pushStats() {
  const monthly = db.prepare(
    `SELECT substr(datetime(at,'+7 hours'),1,7) ym, COUNT(*) n, SUM(ok) sent
       FROM push_log GROUP BY ym ORDER BY ym DESC LIMIT 12`
  ).all();
  const KIND_TH = { paid: 'ยืนยันชำระ/คิว', queue: 'แจ้งเตือนคิว', winback: 'ดึงลูกค้ากลับ', birthday: 'วันเกิด', other: 'อื่น ๆ (ระบบ)' };
  const byKind = db.prepare(
    `SELECT kind, COUNT(*) n FROM push_log
      WHERE substr(datetime(at,'+7 hours'),1,7) = substr(datetime('now','+7 hours'),1,7)
      GROUP BY kind ORDER BY n DESC`
  ).all().map((r) => ({ ...r, label: KIND_TH[r.kind] || r.kind }));
  const today = db.prepare(`SELECT COUNT(*) n FROM push_log WHERE date(at,'+7 hours')=date('now','+7 hours')`).get().n;
  return { monthly, byKind, today };
}
/** Per-day LINE-push counts for a Bangkok date range (owner cost report: จากวัน X ถึงวัน X).
 *  Defaults to the last 31 days. Returns every day's count + the range total. */
export function pushStatsRange(from = null, to = null) {
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from
    : db.prepare("SELECT date(datetime('now','+7 hours'),'-30 days') d").get().d;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : today;
  const daily = db.prepare(
    `SELECT date(at,'+7 hours') day, COUNT(*) n, SUM(ok) sent
       FROM push_log WHERE date(at,'+7 hours') BETWEEN ? AND ?
      GROUP BY day ORDER BY day DESC`
  ).all(f, t);
  return { from: f, to: t, daily,
    total: daily.reduce((s, r) => s + r.n, 0), sent: daily.reduce((s, r) => s + (r.sent || 0), 0) };
}
/** Full customer list + lifecycle segment for the CRM page. Segments (Bangkok days since last
 *  paid visit): new = ≤1 visit · regular = ≤30d · at_risk = 31–60d · lost = >60d (or never paid).
 *  canPush = real LINE user (tel:-only customers can't receive LINE messages). */
export function customersList() {
  const nsRules = getNoshowRules(); const nsOn = noshowEnabled();
  const rows = db.prepare(
    `SELECT c.line_user_id AS key, c.name, c.points, c.lifetime_points AS lifetime, c.birthday,
            COUNT(DISTINCT CASE WHEN o.payment_status='paid' THEN t.id END) AS visits,
            COALESCE(SUM(CASE WHEN o.payment_status='paid' THEN o.total - COALESCE(o.discount,0) END),0) AS spend,
            MAX(CASE WHEN o.payment_status='paid' THEN o.paid_at END) AS lastVisit,
            AVG(CASE WHEN t.rating IS NOT NULL THEN t.rating END) AS ratingAvg,
            COUNT(DISTINCT CASE WHEN t.rating IS NOT NULL THEN t.id END) AS ratingCount,
            MAX(CASE WHEN t.rating IS NOT NULL THEN t.rating END) AS ratingLast,
            COUNT(DISTINCT CASE WHEN t.status='no_show'
                  AND COALESCE(t.closed_at, t.created_at) > COALESCE(c.noshow_forgiven_at, '1970-01-01')
                  AND COALESCE(t.closed_at, t.created_at) >= datetime('now', ?) THEN t.id END) AS noshows
       FROM customers c
       LEFT JOIN tickets t ON t.line_user_id = c.line_user_id
       LEFT JOIN orders o  ON o.ticket_id = t.id
      GROUP BY c.line_user_id`
  ).all(`-${nsRules.windowDays} days`);
  const now = Date.now();
  return rows.map((r) => {
    const days = r.lastVisit ? Math.floor((now - new Date(r.lastVisit.replace(' ', 'T') + 'Z').getTime()) / 86400000) : null;
    const segment = (r.visits <= 1) ? 'new' : (days == null || days > 60) ? 'lost' : (days > 30) ? 'at_risk' : 'regular';
    return { ...r, spend: r2(r.spend), daysSince: days, segment, canPush: String(r.key || '').startsWith('U'),
      ratingAvg: r.ratingAvg != null ? Math.round(r.ratingAvg * 10) / 10 : null, ratingCount: r.ratingCount || 0,
      noshows: r.noshows || 0,
      noshowTier: !nsOn ? null : ((r.noshows || 0) >= nsRules.blockLimit ? 'blocked'
        : ((r.noshows || 0) >= nsRules.limit ? 'prepay' : null)),
      noshowBlocked: nsOn && (r.noshows || 0) >= nsRules.blockLimit };
  }).sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || ''));
}
/** Targeted CRM send: message (+ optional attached coupon) to EXPLICITLY chosen customers.
 *  A coupon is issued into customer_coupons first so "รับคูปอง" in the message is already true when
 *  the customer opens the app. Results are persisted per campaign (sent/failed) — the owner asked
 *  to see whether a blast actually went out. */
export async function sendCampaign({ keys = [], message, coupon = null, actorId = null } = {}) {
  const msg = String(message || '').trim().slice(0, 400);
  if (!msg) throw new Error('empty_message');
  const targets = [...new Set(keys)].filter((k) => String(k || '').startsWith('U')).slice(0, 500);
  if (!targets.length) throw new Error('no_targets');
  // Two ways to attach a gift: pick a coupon already built on the coupon page (couponId — value,
  // expiry, per-customer limit and quota all come from that ONE definition), or type a one-off
  // (label/cap/days). The owner asked for the first to be the norm: define once, reference everywhere.
  const tplWb = couponTemplate('winback');
  let cp = null;
  if (coupon && coupon.couponId) {
    const c = db.prepare('SELECT * FROM coupons WHERE id=? AND active=1').get(Number(coupon.couponId));
    if (!c) throw new Error('coupon_not_found');
    cp = { couponId: c.id, label: c.label,
           cap: Math.max(1, c.disc_type === 'percent' ? (c.max_disc || 0) : c.disc_value),
           days: c.valid_days > 0 ? c.valid_days : null, fixedExpiry: c.expires_at || null };
  } else if (coupon && coupon.label) {
    cp = { label: String(coupon.label).slice(0, 80),
           cap: Math.max(1, Math.min(500, Number(coupon.cap) || tplWb.value)),
           days: Math.max(1, Math.min(90, Math.round(Number(coupon.days) || tplWb.days))) };
  }
  const expiresAt = !cp ? null
    : cp.days ? db.prepare(`SELECT date(datetime('now','+7 hours'),'+' || ? || ' days') d`).get(cp.days).d
    : (cp.fixedExpiry || db.prepare(`SELECT date(datetime('now','+7 hours'),'+30 days') d`).get().d);
  let sent = 0, failed = 0, issuedCoupons = 0;
  for (const key of targets) {
    let ok = false;
    try {
      // A coupon campaign now goes out as the branded YO-DEE coupon card (Phase 4A) — ONE Flex message
      // carrying the owner's message + the coupon; no attachment, no extra send. Message-only campaigns
      // stay a plain text push.
      ok = cp
        ? (await pushCouponFlex(key, { label: cp.label, disc_type: 'amount', disc_value: cp.cap, expiresAt }, shopLink(), msg, 'winback')) !== false
        : (await pushQueue(key, msg, shopLink(), 'สั่งเลย', 'winback')) !== false;
    } catch { ok = false; }
    if (ok) sent++; else failed++;
    // Issue the coupon only when the customer was actually TOLD about it — a blocked/failed push
    // must not strand a silent liability in their wallet. With LINE stubbed (UAT/dev) every push
    // reports false, so we still issue there or the whole flow would be untestable.
    if (cp && (ok || !LINE_ENABLED)) {
      if (cp.couponId) {
        // Same discipline as claimCoupon: take quota atomically, and the unique
        // (coupon_id, customer_key) index makes re-sending to the same customer a no-op instead of
        // stacking duplicate gifts — quota is handed back when that happens.
        const took = db.prepare(
          'UPDATE coupons SET issued_count = issued_count + 1 WHERE id=? AND active=1 AND (issue_limit<=0 OR issued_count < issue_limit)'
        ).run(cp.couponId);
        if (took.changes) {
          try {
            db.prepare(`INSERT INTO customer_coupons (customer_key, coupon_id, kind, label, free_cap, expires_at, source) VALUES (?, ?, 'winback', ?, ?, ?, 'campaign')`)
              .run(key, cp.couponId, cp.label, cp.cap, expiresAt);
            issuedCoupons++;
          } catch { db.prepare('UPDATE coupons SET issued_count = MAX(0, issued_count - 1) WHERE id=?').run(cp.couponId); }
        }
      } else {
        db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'winback', ?, ?, ?, 'campaign')`)
          .run(key, cp.label, cp.cap, expiresAt);
        issuedCoupons++;
      }
    }
  }
  const info = db.prepare(
    `INSERT INTO crm_campaigns (message, coupon_label, coupon_cap, coupon_days, targeted, sent, failed, actor_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(msg, cp ? cp.label : null, cp ? cp.cap : null, cp ? cp.days : null, targets.length, sent, failed, actorId);
  return { ok: true, campaignId: Number(info.lastInsertRowid), targeted: targets.length, sent, failed, couponAttached: !!cp, issuedCoupons };
}
// ---------- แม่แบบคูปอง (coupon templates) ----------
// ONE registry defines every automatic giveaway's value/expiry, so the owner edits ฿ amounts on a
// screen instead of in code. Backed by the same settings table the lucky campaign already uses;
// lucky keeps its lucky:* keys and is shown alongside these in the hub UI.
// `toggle:false` templates can't be switched off here: reward follows the loyalty switch (turning
// it off alone would strand completed stamp cards), and winback is a manual send anyway.
const TPL_DEFS = {
  birthday: { name: 'ของขวัญวันเกิด', value: 100, days: 30, toggle: true },
  reward:   { name: 'สะสมครบ → เครื่องดื่มฟรี', value: 49, days: 30, toggle: false },
  winback:  { name: 'ดึงลูกค้ากลับ (ค่าเริ่มต้น)', value: 49, days: 30, toggle: false },
};
/** The ฿ worth of a coupons-row when used as a GIFT template: a baht coupon gives its value, a
 *  percent coupon gives its cap (that is the most it can ever be worth). */
function couponGiftValue(c, fallback) {
  return Math.max(1, (c.disc_type === 'percent' ? (c.max_disc || fallback) : c.disc_value) || fallback);
}
export function couponTemplate(key) {
  const d = TPL_DEFS[key];
  if (!d) throw new Error('unknown_template');
  const t = {
    key, name: d.name, toggle: d.toggle,
    value: Math.max(1, Math.min(2000, Math.round(Number(getSetting(`tpl:${key}:value`, String(d.value))) || d.value))),
    days: Math.max(1, Math.min(365, Math.round(Number(getSetting(`tpl:${key}:days`, String(d.days))) || d.days))),
    on: d.toggle ? getSetting(`tpl:${key}:on`, '1') === '1' : true,
    couponId: null, couponLabel: null,
  };
  // Bound to a coupon built on the coupon page (owner rule: every coupon is defined in ONE place
  // and campaigns reference it). The coupon's value/expiry/label override the hand-typed numbers;
  // if the coupon is later deleted or switched off, the campaign falls back to those numbers
  // instead of dying.
  const cid = Math.round(Number(getSetting(`tpl:${key}:coupon_id`, '')) || 0) || null;
  if (cid) {
    const c = db.prepare('SELECT * FROM coupons WHERE id=? AND active=1').get(cid);
    if (c) {
      t.couponId = c.id; t.couponLabel = c.label;
      t.value = couponGiftValue(c, t.value);
      if (c.valid_days > 0) t.days = c.valid_days;
    }
  }
  return t;
}
export function couponTemplates() { return Object.keys(TPL_DEFS).map(couponTemplate); }
export function setCouponTemplate(key, { value, days, on, couponId } = {}) {
  // 'lucky' rides the same endpoint so the hub has ONE save path, but its numbers live in the
  // campaign's own lucky:* settings — only the coupon binding is stored here.
  if (key === 'lucky') {
    if (couponId !== undefined) setLuckyCoupon(couponId);
    return luckyStatus();
  }
  const d = TPL_DEFS[key];
  if (!d) throw new Error('unknown_template');
  if (couponId !== undefined) {
    if (couponId === null || couponId === '' || Number(couponId) === 0) setSetting(`tpl:${key}:coupon_id`, '');
    else {
      if (!db.prepare('SELECT id FROM coupons WHERE id=? AND active=1').get(Number(couponId))) throw new Error('coupon_not_found');
      setSetting(`tpl:${key}:coupon_id`, String(Math.round(Number(couponId))));
    }
  }
  if (value != null) setSetting(`tpl:${key}:value`, String(Math.max(1, Math.min(2000, Math.round(Number(value) || d.value)))));
  if (days != null) setSetting(`tpl:${key}:days`, String(Math.max(1, Math.min(365, Math.round(Number(days) || d.days)))));
  if (on != null && d.toggle) setSetting(`tpl:${key}:on`, on ? '1' : '0');
  return couponTemplate(key);
}
const COUPON_KIND_TH = { winback: 'ดึงลูกค้ากลับ', birthday: 'วันเกิด', reward: 'สะสมครบ', lucky: 'เลขนำโชค', claim: 'ลิงก์รับคูปอง',
                         bounceback: 'ขอบคุณกลับมาอีก', streak: 'ซื้อต่อเนื่อง', flash: 'Flash Sale' };
/**
 * Coupon performance for a Bangkok date range: how many went out, how many came back, and what it
 * actually cost. Redemptions are counted on the day they were USED (that is when the shop paid for
 * it), issues on the day they were issued — so the two columns answer different questions on
 * purpose and should not be read as a same-cohort rate.
 * Value comes from used_value, which is the discount really given; rows redeemed before that column
 * existed have no value and are reported separately rather than guessed at from free_cap.
 */
export function couponReport({ from = null, to = null, days = null } = {}) {
  const today = db.prepare("SELECT date('now','+7 hours') d").get().d;
  let f = from, t = to;
  if (!f || !t) {
    const n = Math.max(1, Math.min(3650, Math.round(Number(days) || 30)));
    t = today;
    f = db.prepare("SELECT date('now','+7 hours','-' || ? || ' days') d").get(n - 1).d;
  }
  const bkk = (col) => `date(${col},'+7 hours')`;
  const issued = db.prepare(
    `SELECT kind, COUNT(*) n, COALESCE(SUM(free_cap),0) face
       FROM customer_coupons WHERE ${bkk('issued_at')} BETWEEN ? AND ? GROUP BY kind`).all(f, t);
  const redeemed = db.prepare(
    `SELECT kind, COUNT(*) n, COALESCE(SUM(used_value),0) value,
            SUM(CASE WHEN used_value IS NULL THEN 1 ELSE 0 END) unpriced
       FROM customer_coupons
      WHERE used_at IS NOT NULL AND ${bkk('used_at')} BETWEEN ? AND ? GROUP BY kind`).all(f, t);
  const expired = db.prepare(
    `SELECT COUNT(*) n FROM customer_coupons
      WHERE used_at IS NULL AND state != 'cancelled' AND expires_at BETWEEN ? AND ?`).get(f, t).n || 0;
  // Shop-wide CODE coupons live in a different table and already record their discount.
  const code = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(discount),0) value FROM coupon_uses
      WHERE ${bkk('at')} BETWEEN ? AND ?`).get(f, t);

  const kinds = [...new Set([...issued.map((r) => r.kind), ...redeemed.map((r) => r.kind)])];
  const rows = kinds.map((k) => {
    const i = issued.find((x) => x.kind === k) || { n: 0, face: 0 };
    const u = redeemed.find((x) => x.kind === k) || { n: 0, value: 0, unpriced: 0 };
    return { kind: k, label: COUPON_KIND_TH[k] || k, issued: i.n, faceValue: r2(i.face),
             redeemed: u.n, value: r2(u.value), unpriced: u.unpriced || 0 };
  }).sort((a, b) => b.issued - a.issued);

  const totIssued = rows.reduce((s, r) => s + r.issued, 0);
  const totRedeemed = rows.reduce((s, r) => s + r.redeemed, 0);
  return {
    from: f, to: t,
    issued: totIssued,
    redeemed: totRedeemed,
    value: r2(rows.reduce((s, r) => s + r.value, 0)),
    unpriced: rows.reduce((s, r) => s + r.unpriced, 0),
    expired,
    redeemRate: totIssued ? Math.round((totRedeemed / totIssued) * 1000) / 10 : 0,
    rows,
    codeCoupons: { redeemed: code.n || 0, value: r2(code.value || 0) },
  };
}

/** Every wallet coupon by lifecycle status, with WHO holds it. Default 'live' answers the number
 *  the owner never had (฿ liability still out there); the owner also asked to check a SPECIFIC
 *  customer's coupon — did they use it, when, or did it lapse — so the same list now serves
 *  redeemed (with the date it was used), expired, and cancelled views behind a status filter. */
export function outstandingCoupons({ q = '', status = 'live', limit = 50, offset = 0 } = {}) {
  const today = db.prepare("SELECT date('now','+7 hours') d").get().d;
  const term = String(q || '').trim();
  const filter = term ? ` AND (cc.label LIKE ? OR COALESCE(c.name,'') LIKE ? OR cc.customer_key LIKE ?)` : '';
  const qArgs = term ? [`%${term}%`, `%${term}%`, `%${term}%`] : [];
  const WHERE = {
    live: { sql: `cc.used_at IS NULL AND cc.state != 'cancelled' AND cc.expires_at >= ?`, today: true },
    redeemed: { sql: `cc.used_at IS NOT NULL`, today: false },
    expired: { sql: `cc.used_at IS NULL AND cc.state != 'cancelled' AND cc.expires_at < ?`, today: true },
    cancelled: { sql: `cc.state = 'cancelled' AND cc.used_at IS NULL`, today: false },
  };
  const st = WHERE[status] ? status : 'live';
  const from = `FROM customer_coupons cc LEFT JOIN customers c ON c.line_user_id = cc.customer_key`;
  const argsFor = (k) => (WHERE[k].today ? [today, ...qArgs] : qArgs);
  // Chip counts honour the search box too, so "จันทร์แจ่ม" shows her whole coupon history at once.
  const counts = {};
  for (const k of Object.keys(WHERE)) {
    counts[k] = db.prepare(`SELECT COUNT(*) n ${from} WHERE ${WHERE[k].sql}${filter}`).get(...argsFor(k)).n || 0;
  }
  // ฿ shown next to the count means: liability for live, real discount given for redeemed,
  // face value that quietly lapsed for expired/cancelled.
  const sumExpr = st === 'redeemed' ? 'COALESCE(SUM(cc.used_value),0)' : 'COALESCE(SUM(cc.free_cap),0)';
  const tot = db.prepare(`SELECT ${sumExpr} amt ${from} WHERE ${WHERE[st].sql}${filter}`).get(...argsFor(st));
  const order = st === 'redeemed' ? 'cc.used_at DESC, cc.id DESC'
    : st === 'live' ? 'cc.expires_at, cc.id' : 'cc.id DESC';
  const rows = db.prepare(
    `SELECT cc.id, cc.customer_key AS key, COALESCE(c.name,'') AS name, cc.kind, cc.label,
            cc.free_cap AS cap, cc.used_value AS usedValue, date(cc.issued_at,'+7 hours') AS issued,
            cc.expires_at AS expires, date(cc.used_at,'+7 hours') AS usedOn
       ${from} WHERE ${WHERE[st].sql}${filter} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...argsFor(st), Math.max(1, Math.min(200, limit)), Math.max(0, offset));
  return { total: counts[st], liability: r2(tot.amt || 0), today, status: st, counts,
           rows: rows.map((r) => ({ ...r, kindTh: COUPON_KIND_TH[r.kind] || r.kind })) };
}

/** Spreadsheet-style coupon report: one row per coupon NAME (not just kind) with issued/redeemed/
 *  ฿/rate/expired/last-used, plus the individual redemptions so the owner can see exactly WHO used
 *  WHAT on WHICH day. Defaults to the last 7 Bangkok days — the window the owner reads daily. */
export function couponReportSheet({ from = null, to = null } = {}) {
  const today = db.prepare("SELECT date('now','+7 hours') d").get().d;
  let f = from, t = to;
  if (!f || !t) { t = today; f = db.prepare("SELECT date('now','+7 hours','-6 days') d").get().d; }
  const bkk = (col) => `date(${col},'+7 hours')`;
  const issued = db.prepare(
    `SELECT kind, label, COUNT(*) n, COALESCE(SUM(free_cap),0) face
       FROM customer_coupons WHERE ${bkk('issued_at')} BETWEEN ? AND ? GROUP BY kind, label`).all(f, t);
  const used = db.prepare(
    `SELECT kind, label, COUNT(*) n, COALESCE(SUM(used_value),0) value,
            MAX(${bkk('used_at')}) lastUsed,
            ROUND(AVG(julianday(used_at) - julianday(issued_at)), 1) avgDays
       FROM customer_coupons WHERE used_at IS NOT NULL AND ${bkk('used_at')} BETWEEN ? AND ?
      GROUP BY kind, label`).all(f, t);
  const lapsed = db.prepare(
    `SELECT kind, label, COUNT(*) n FROM customer_coupons
      WHERE used_at IS NULL AND state != 'cancelled' AND expires_at BETWEEN ? AND ? AND expires_at < ?
      GROUP BY kind, label`).all(f, t, today);
  const SEP = String.fromCharCode(0);   // labels contain spaces, so join on a char no label can hold
  const keys = [...new Set([...issued, ...used, ...lapsed].map((r) => r.kind + SEP + (r.label || '')))];
  const rows = keys.map((k) => {
    const [kind, label] = k.split(SEP);
    const pick = (a) => a.find((x) => x.kind === kind && x.label === label);
    const i = pick(issued) || { n: 0, face: 0 };
    const u = pick(used) || { n: 0, value: 0, lastUsed: null, avgDays: null };
    const e = pick(lapsed) || { n: 0 };
    return { kind, kindTh: COUPON_KIND_TH[kind] || kind, label,
             issued: i.n, faceValue: r2(i.face), redeemed: u.n, value: r2(u.value),
             rate: i.n ? Math.round((u.n / i.n) * 1000) / 10 : null,
             expired: e.n, lastUsed: u.lastUsed, avgDays: u.avgDays };
  }).sort((a, b) => b.issued - a.issued || b.redeemed - a.redeemed);
  const uses = db.prepare(
    `SELECT ${bkk('cc.used_at')} d, cc.kind, cc.label, COALESCE(c.name,'') name,
            cc.customer_key key, cc.used_value value
       FROM customer_coupons cc LEFT JOIN customers c ON c.line_user_id = cc.customer_key
      WHERE cc.used_at IS NOT NULL AND ${bkk('cc.used_at')} BETWEEN ? AND ?
      ORDER BY cc.used_at DESC LIMIT 300`).all(f, t)
    .map((r) => ({ ...r, kindTh: COUPON_KIND_TH[r.kind] || r.kind, value: r.value == null ? null : r2(r.value) }));
  return { from: f, to: t, rows, uses };
}
/** Owner recalls a mis-issued coupon. Only unused coupons can be cancelled; the customer simply
 *  stops seeing it. Issued-count history is kept — the report still shows it went out. */
export function cancelCustomerCoupon(ccId, actorId = null) {
  const cc = db.prepare('SELECT id, label, customer_key FROM customer_coupons WHERE id=?').get(ccId);
  if (!cc) throw new Error('coupon_not_found');
  const r = db.prepare(`UPDATE customer_coupons SET state='cancelled' WHERE id=? AND used_at IS NULL AND state != 'cancelled'`).run(ccId);
  if (!r.changes) throw new Error('coupon_not_cancellable');
  logSaleEvent({ branchId: null, ticketId: null, orderId: null, type: 'coupon_cancel', amount: 0, actor: actorId,
                 meta: { couponId: Number(ccId), label: cc.label, customer: cc.customer_key } });
  return { ok: true, id: Number(ccId) };
}

export function listCampaigns(limit = 20) {
  return db.prepare(
    `SELECT cc.*, s.name AS actor_name FROM crm_campaigns cc LEFT JOIN staff s ON s.id = cc.actor_id
      ORDER BY cc.id DESC LIMIT ?`
  ).all(Math.max(1, Math.min(100, limit)));
}
export function lapsedLineCustomers(days = 30) {
  const d = Math.max(1, Math.floor(Number(days) || 30));
  return db.prepare(
    `SELECT c.line_user_id AS lineUserId, c.name AS name,
            MAX(o.paid_at) AS lastVisit, COUNT(DISTINCT t.id) AS visits
     FROM customers c
     JOIN tickets t ON t.line_user_id = c.line_user_id
     JOIN orders o  ON o.ticket_id = t.id AND o.payment_status='paid'
     WHERE c.line_user_id LIKE 'U%'
     GROUP BY c.line_user_id
     HAVING julianday('now') - julianday(MAX(o.paid_at)) >= ?
     ORDER BY lastVisit DESC`
  ).all(d);
}
/** Owner action: push a win-back message to lapsed LINE customers. Capped (OA quota friendliness).
 *  Best-effort — never throws on a single failed push. On UAT (LINE stubbed) it logs and `sent`
 *  stays 0, but `targeted` still shows who WOULD receive it. Returns counts for the UI. */
export async function winBackBlast(message, { days = 30, max = 300 } = {}) {
  const msg = String(message || '').trim().slice(0, 400);
  if (!msg) throw new Error('empty_message');
  const all = lapsedLineCustomers(days);
  const list = all.slice(0, Math.max(1, Math.min(max, 1000)));
  let sent = 0;
  for (const c of list) {
    try { if ((await pushQueue(c.lineUserId, msg, null, 'สั่งเลย', 'winback')) !== false) sent++; } catch { /* skip one */ }
  }
  return { targeted: all.length, attempted: list.length, sent, capped: all.length > list.length };
}

/** Daily report: cups sold, no-shows, avg wait, avg rating + per-zone, since the last reset. */
export function dailyReport(branchId = null, dateStr = null) {
  const B = [branchId, branchId];   // for "(? IS NULL OR <branch col>=?)" guards
  // "Today" (or an explicit YYYY-MM-DD via dateStr) = a Bangkok calendar day. Every figure is
  // date-filtered to that day so the report is always correct regardless of the midnight reset
  // (orders/tickets persist for history). dateStr is internal-only (validated) — used to archive
  // the day that just ended.
  const validDay = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const TODAY = validDay ? `'${dateStr}'` : `date('now','+7 hours')`;
  const perZone = db.prepare(
    `SELECT z.id, z.name, z.prefix,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.number>0 AND date(t.numbered_at,'+7 hours')=${TODAY}) AS issued,  -- queue numbers actually issued today (numbered_at: at payment under pay-first, at creation under queue-first)
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served'  AND date(t.closed_at,'+7 hours')=${TODAY}) AS served,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show' AND date(t.closed_at,'+7 hours')=${TODAY}) AS no_shows
     FROM zones z WHERE (? IS NULL OR z.store_id=?) ORDER BY z.id`
  ).all(...B);
  const cupsSold = perZone.reduce((s, z) => s + z.served, 0);
  const issued = perZone.reduce((s, z) => s + z.issued, 0);
  const noShows = perZone.reduce((s, z) => s + z.no_shows, 0);
  const wait = db.prepare(
    `SELECT AVG((julianday(called_at)-julianday(created_at))*86400) AS s
     FROM tickets WHERE called_at IS NOT NULL AND date(created_at,'+7 hours')=${TODAY} AND (? IS NULL OR store_id=?)`
  ).get(...B);
  const rating = db.prepare(
    `SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM tickets WHERE rating IS NOT NULL AND date(created_at,'+7 hours')=${TODAY} AND (? IS NULL OR store_id=?)`
  ).get(...B);
  // Item sales tagged drink/topping via the menu (so we can split the P&L and count cups).
  const itemSales = db.prepare(
    `SELECT oi.name,
            COALESCE(mi.category,'drink') AS category,
            SUM(oi.qty) AS qty,
            SUM(oi.qty*oi.price) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     -- Category comes from the item's pinned catalog id (rename-proof), falling back to name only for
     -- legacy rows with no menu_item_id. Matching by name meant renaming a menu item restated the
     -- drink/topping split of every CLOSED day (ACC-F4).
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id OR (oi.menu_item_id IS NULL AND mi.name = oi.name)
     WHERE o.payment_status = 'paid' AND date(o.paid_at,'+7 hours')=${TODAY} AND (? IS NULL OR o.branch_id=?)   -- SALES = paid TODAY only (pay-first); optional branch
     GROUP BY oi.name ORDER BY revenue DESC`
  ).all(...B);
  const grossSales = itemSales.reduce((s, i) => s + (i.revenue || 0), 0);
  itemSales.forEach((i) => { i.pct = grossSales ? i.revenue / grossSales : 0; });
  const drinkSales = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.revenue, 0);
  const toppingSales = grossSales - drinkSales;
  const cups = itemSales.filter((i) => i.category !== 'topping').reduce((s, i) => s + i.qty, 0);
  // Bill discounts on non-void orders reduce NET sales. revenue = gross − discounts
  // (defaults to gross since discounts are 0 until used — no behavior change).
  const discounts = db.prepare(`SELECT COALESCE(SUM(o.discount),0) AS d FROM orders o WHERE o.payment_status = 'paid' AND date(o.paid_at,'+7 hours')=${TODAY} AND (? IS NULL OR o.branch_id=?)`).get(...B).d || 0;
  const revenue = Math.round((grossSales - discounts) * 100) / 100;

  // Cancelled / refunded / wasted orders — all excluded from sales above, reported separately.
  const vAgg = db.prepare(
    `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.total),0) AS amount
     FROM orders o WHERE o.payment_status='void' AND date(o.voided_at,'+7 hours')=${TODAY} AND (? IS NULL OR o.branch_id=?)`
  ).get(...B);
  const vCups = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(mi.category,'drink')!='topping' THEN oi.qty ELSE 0 END),0) AS cups
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     LEFT JOIN menu_items mi ON mi.name=oi.name
     WHERE o.payment_status='void' AND date(o.voided_at,'+7 hours')=${TODAY} AND (? IS NULL OR o.branch_id=?)`
  ).get(...B);
  // Break the voids down by kind so the report shows: cancelled (neutral, no money),
  // refunded (money returned), waste (made-but-binned → a COST with no revenue).
  const vByKind = db.prepare(
    `SELECT COALESCE(o.void_kind,'void') AS kind, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.total),0) AS amount,
            COALESCE(SUM((SELECT COALESCE(SUM(CASE WHEN COALESCE(mi.category,'drink')!='topping' THEN oi.qty ELSE 0 END),0)
                          FROM order_items oi LEFT JOIN menu_items mi ON mi.name=oi.name WHERE oi.order_id=o.id)),0) AS cups
     FROM orders o WHERE o.payment_status='void' AND date(o.voided_at,'+7 hours')=${TODAY} AND (? IS NULL OR o.branch_id=?)
     GROUP BY COALESCE(o.void_kind,'void')`
  ).all(...B);
  const byKind = { void:{orders:0,amount:0,cups:0}, refund:{orders:0,amount:0,cups:0}, waste:{orders:0,amount:0,cups:0} };
  for (const r of vByKind) byKind[r.kind] = { orders: r.orders, amount: r.amount, cups: r.cups };
  const voided = { orders: vAgg.orders, amount: vAgg.amount, cups: vCups.cups,
    cancelled: byKind.void, refunded: byKind.refund, waste: byKind.waste };

  // P&L from the financial settings (today's sales vs prorated daily fixed costs).
  const f = getFinanceSettings(branchId);
  const perDay = (monthly) => (f.daysPerMonth > 0 ? monthly / f.daysPerMonth : monthly);
  // Ingredient cost: same actual-over-plan discipline as labour. When recipes auto-deduct stock,
  // cogsForDay() nets the day's use/return moves at weighted-avg cost — that replaces the
  // %-of-revenue estimate, and the variance is surfaced instead of the plan quietly hiding it.
  // Whole-shop figure only (stock moves aren't branch-filtered), so a branch-scoped report keeps
  // the plan number. Zero moves (no recipes yet) = plan as before.
  const ingredientPlan = f.ingredientPct * revenue;
  let ingredient = ingredientPlan, ingredientActual = null, stockWasteVal = 0;
  if (branchId == null) {
    try {
      const ca = cogsForDay(validDay ? dateStr : null);
      stockWasteVal = ca.wasteCost || 0;
      if (ca.cogsActual > 0) { ingredient = ca.cogsActual; ingredientActual = ca.cogsActual; }
    } catch { /* stock module empty */ }
  }
  const ingredientVariance = ingredientActual != null ? Math.round((ingredientActual - ingredientPlan) * 100) / 100 : 0;
  // Packaging: a PLAN-mode estimate (perCup × cups). In ACTUAL mode the real cups/lids/straws consumed
  // by sold drinks are already inside cogsActual (their stock 'use' moves fired at payment), so adding
  // the estimate on top double-counts the whole packaging line (ACC-F2) → 0. A shop that doesn't track
  // packaging in stock should add it to the recipe so it lands in real COGS.
  const packaging = ingredientActual != null ? 0 : f.packagingPerCup * cups;
  const freight = perDay(f.freight);              // freight-in belongs to COGS, not to opex
  const cogs = ingredient + packaging + freight;
  const grossProfit = revenue - cogs;
  // Waste = product made then discarded: its ingredient+packaging is spent but earns nothing.
  // A real cost with no revenue → it reduces net profit (separate from sold-goods COGS).
  // In ACTUAL mode the binned orders' ingredients already sit inside cogsActual (their 'use' moves
  // were never returned) — charging the % again would double-count, so the waste line is then
  // packaging of the binned cups + manually recorded stock waste only.
  const wasteCost = ingredientActual != null
    ? Math.round((byKind.waste.cups * f.packagingPerCup + stockWasteVal) * 100) / 100
    : Math.round((byKind.waste.amount * f.ingredientPct + byKind.waste.cups * f.packagingPerCup) * 100) / 100;
  voided.waste.cost = wasteCost;
  // Operating expenses, grouped. Depreciation / interest / tax deliberately sit BELOW this line
  // so the report can show EBITDA → EBIT → กำไรก่อนภาษี → กำไรสุทธิ like a real set of accounts.
  const opexKeys = OPEX_GROUPS.flatMap(([, , keys]) => keys);
  const monthlyOpex = opexKeys.reduce((s, k) => s + f[k], 0);
  const opexLines = Object.fromEntries(opexKeys.map((k) => [k, f[k]]));
  // Time clock: if anyone actually clocked a shift on this day, the wage line stops being a guess.
  // We swap the prorated ค่าแรง for what the day really cost and record the difference, so the
  // owner can see "จ้างเกินแผน ฿420" instead of the plan quietly hiding it. No shifts = no change.
  const labor = laborActual(validDay ? dateStr : null);
  const wagesPlanDaily = perDay(f.wages);
  const laborVariance = labor.cost > 0 ? Math.round((labor.cost - wagesPlanDaily) * 100) / 100 : 0;
  const dailyOpex = perDay(monthlyOpex) + laborVariance;   // no rounding: with no shifts this must stay bit-identical to the plan
  const opexGroups = OPEX_GROUPS.map(([key, label, keys]) => {
    const daily = (k) => (k === 'wages' && labor.cost > 0 ? labor.cost : perDay(f[k]));
    const lbl = (k) => (k === 'wages' && labor.cost > 0 ? `${FIN_LABELS[k]} (ลงเวลาจริง ${labor.hours} ชม.)` : FIN_LABELS[k]);
    return {
      key, label, monthly: keys.reduce((s, k) => s + f[k], 0),
      daily: keys.reduce((s, k) => s + daily(k), 0),
      lines: keys.filter((k) => f[k] > 0 || daily(k) > 0)
        .map((k) => ({ key: k, label: lbl(k), monthly: f[k], daily: daily(k) })),
    };
  });
  // Cash taken OUT of the drawer that day (ซื้อน้ำแข็ง/ถุง/ของใช้) is a real expense paid from
  // takings. The drawer reconciliation already expects it to be gone, but until now it never
  // reached the P&L — so net profit was overstated by exactly the amount spent.
  const drawerPayOut = payOutForDay(branchId || 1, validDay ? dateStr : null);
  // Delivery-platform commission (Grab/LINE MAN/Shopee take ~30% of each order) is a real cost of the
  // sale — it was computed for the channel report but never reached the profit line, so net profit was
  // overstated by the whole fee (ACC-F3). Same basis as channelsReport: net-of-discount × commission%.
  const commission = Math.round((db.prepare(
    `SELECT COALESCE(SUM((o.total - COALESCE(o.discount,0)) * COALESCE(c.commission_pct,0) / 100), 0) v
       FROM orders o LEFT JOIN channels c ON c.id = o.channel_id
      WHERE o.payment_status='paid' AND date(o.paid_at,'+7 hours') = COALESCE(?, date('now','+7 hours'))
        AND (? IS NULL OR o.branch_id = ?)`
  ).get(dateStr, branchId, branchId).v || 0) * 100) / 100;
  const ebitda = grossProfit - commission - wasteCost - dailyOpex - drawerPayOut;
  const depreciation = perDay(f.depreciation);
  const ebit = ebitda - depreciation;
  const interest = perDay(f.interest);
  const preTax = ebit - interest;
  const taxRate = Math.max(0, Math.min(0.5, f.taxPct > 1 ? f.taxPct / 100 : f.taxPct)); // accepts 20 or 0.20
  const incomeTax = preTax > 0 ? preTax * taxRate : 0;   // no tax on a loss
  const netProfit = preTax - incomeTax;
  // Break-even: how many cups/day cover the prorated fixed costs, using the menu's
  // average drink price (so it's meaningful even before the first sale of the day).
  const fixedDaily = dailyOpex + depreciation + interest;
  const refAvg = db.prepare("SELECT AVG(price) AS a FROM menu_items WHERE category='drink' AND active=1").get().a || 0;
  const contribPerCup = refAvg * (1 - f.ingredientPct) - f.packagingPerCup;
  const breakEvenCups = contribPerCup > 0 ? Math.ceil(fixedDaily / contribPerCup) : null;
  const targetDaily = f.targetRevenue > 0 && f.daysPerMonth > 0 ? f.targetRevenue / f.daysPerMonth : null;
  const pnl = {
    drinkSales, toppingSales, cups,
    ingredient, ingredientPlan, ingredientActual, ingredientVariance, packaging, freight, cogs, wasteCost,
    grossProfit, grossMargin: revenue ? grossProfit / revenue : 0,
    opexDaily: dailyOpex, opexMonthly: monthlyOpex, opexLines, opexGroups,
    labor, wagesPlanDaily, laborVariance, drawerPayOut, commission,
    ebitda, depreciation, ebit, interest, preTax, taxRate, incomeTax, fixedDaily,
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
    const v = db.prepare('SELECT void_kind, void_reason FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(t.id);
    return {
      id: t.id, code: t.code, status: t.status, customer_name: t.customer_name,
      closed_at: t.closed_at,
      order_total: o ? o.total : null,
      payment_status: o ? o.payment_status : null,
      void_kind: v ? (v.void_kind || null) : null,
      void_reason: v ? (v.void_reason || null) : null,
      refund_requested: o ? (o.refund_requested || 0) : 0,
      refund_note: o ? (o.refund_note || null) : null,
      has_slip: hasSlip,
      lines: o ? o.lines : [],
    };
  });
}

/** Archive today's sales totals into sales_history (idempotent per date). Run at the
 *  daily reset (and callable on demand) so daily/monthly sell history accrues. */
export function archiveTodaySales(dateStr = null) {
  const validDay = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const rep = dailyReport(null, validDay ? dateStr : null);
  if ((rep.issued || 0) === 0 && (rep.revenue || 0) === 0) return null; // nothing to save
  const dayExpr = validDay ? `'${dateStr}'` : `date('now','+7 hours')`;
  db.prepare(
    `INSERT OR REPLACE INTO sales_history
       (date, cups, revenue, gross, net, void_orders, void_cups, void_amount, issued, served, no_shows,
        drink_sales, topping_sales, cogs, opex, waste_cost)
     VALUES (${dayExpr}, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?)`
  ).run(rep.pnl.cups || 0, rep.revenue || 0, rep.pnl.grossProfit || 0, rep.pnl.netProfit || 0,
        rep.voided.orders || 0, rep.voided.cups || 0, rep.voided.amount || 0,
        rep.issued || 0, rep.cupsSold || 0, rep.noShows || 0,
        rep.pnl.drinkSales || 0, rep.pnl.toppingSales || 0, rep.pnl.cogs || 0, rep.pnl.opexDaily || 0, rep.pnl.wasteCost || 0);
  return rep;
}

/** P&L history from the archive — daily rows + monthly + yearly rollups, each with the full
 *  revenue → COGS → gross profit → opex/waste → net profit chain (cost lines available for days
 *  archived after the breakdown columns shipped; revenue/gross/net are present for all). */
export function salesHistory() {
  const daily = db.prepare('SELECT * FROM sales_history ORDER BY date DESC LIMIT 90').all();
  const roll = (groupExpr, limit) => db.prepare(
    `SELECT ${groupExpr} AS period, COUNT(*) AS days,
            SUM(cups) AS cups, SUM(revenue) AS revenue, SUM(gross) AS gross, SUM(net) AS net,
            SUM(COALESCE(drink_sales,0)) AS drink_sales, SUM(COALESCE(topping_sales,0)) AS topping_sales,
            SUM(COALESCE(cogs,0)) AS cogs, SUM(COALESCE(opex,0)) AS opex, SUM(COALESCE(waste_cost,0)) AS waste_cost,
            SUM(void_cups) AS void_cups, SUM(void_amount) AS void_amount
       FROM sales_history GROUP BY period ORDER BY period DESC LIMIT ?`
  ).all(limit);
  const weekly = roll("strftime('%Y-W%W', date)", 26);   // YYYY-Www (Mon-based ISO-ish week)
  const monthly = roll('substr(date,1,7)', 24);   // YYYY-MM
  const yearly = roll('substr(date,1,4)', 10);     // YYYY
  return { daily, weekly, monthly, yearly };
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
    // NET of discounts, same as payments/channels above — a gross SUM here made the hourly bars
    // add up to more than the day's "ยอดขาย" on the very same report whenever a coupon was used.
    `SELECT strftime('%H', o.paid_at, '+7 hours') AS hr, COUNT(*) AS orders, SUM(o.total - COALESCE(o.discount,0)) AS revenue
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

  // Paid cup + topping unit counts for the day (header summary). Drinks = kind 'base'.
  const unitRow = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN oi.kind = 'base' THEN oi.qty END), 0) AS cups,
            COALESCE(SUM(CASE WHEN oi.kind = 'addon' THEN oi.qty END), 0) AS toppings
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.payment_status = 'paid' AND date(o.paid_at, '+7 hours') = ${DAY} AND ${BR}`
  ).get(D, ...b);
  const cups = unitRow ? unitRow.cups : 0;
  const toppings = unitRow ? unitRow.toppings : 0;

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

  // Order-source mix: how the day's orders came in — LINE self-order (source='customer') vs walk-in
  // counter (cashier, no delivery channel) vs each delivery channel (Grab/LINE MAN…). Share of orders,
  // void excluded. Answers "กี่ % มาจากไลน์ / หน้าร้าน / ช่องทางอื่น ต่อวัน".
  const srcRows = db.prepare(
    `SELECT o.source AS src, c.name AS channel, COALESCE(c.commission_pct,0) AS fee,
            COUNT(*) AS orders, SUM(o.total - COALESCE(o.discount,0)) AS revenue
       FROM orders o
       JOIN tickets t ON t.id = o.ticket_id
       LEFT JOIN channels c ON c.id = o.channel_id
      WHERE o.payment_status != 'void' AND date(COALESCE(o.paid_at, o.created_at), '+7 hours') = ${DAY} AND ${BR}
      GROUP BY o.source, c.name, c.commission_pct`
  ).all(D, ...b);
  const srcBuckets = new Map();
  for (const r of srcRows) {
    let key, label;
    if (r.src === 'customer') { key = 'line'; label = '📱 ลูกค้าสั่งผ่าน LINE'; }
    else if (r.channel && r.fee > 0) { key = 'ch:' + r.channel; label = r.channel; }   // delivery platform
    else { key = 'counter'; label = '🏪 หน้าร้าน'; }                                     // walk-in counter
    const bkt = srcBuckets.get(key) || { key, label, orders: 0, revenue: 0 };
    bkt.orders += r.orders; bkt.revenue += r.revenue || 0;
    srcBuckets.set(key, bkt);
  }
  const sourceTotalOrders = [...srcBuckets.values()].reduce((s, x) => s + x.orders, 0);
  const sources = [...srcBuckets.values()]
    .map((s) => ({ key: s.key, label: s.label, orders: s.orders, revenue: Math.round(s.revenue * 100) / 100,
                   pct: sourceTotalOrders ? Math.round((s.orders / sourceTotalOrders) * 1000) / 10 : 0 }))
    .sort((a, b) => b.orders - a.orders);

  const voidTotals = {};
  for (const v of voids) { const k = v.void_kind || 'void'; (voidTotals[k] = voidTotals[k] || { count: 0, amount: 0 }); voidTotals[k].count++; voidTotals[k].amount += v.total || 0; }
  const paidTotal = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const paidOrders = payments.reduce((s, p) => s + (p.orders || 0), 0);
  return { date: D, transactions, payments, paidTotal, paidOrders, cups, toppings, discounts, discountTotal, channels: channelsReport, channelTotals, sources, sourceTotalOrders, voids, voidTotals, addons, hourly, topItems };
}

// ---------- Cash drawer / Z-report (end-of-day cash-up) ----------
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
function cashComponents(branchId, sinceAt) {
  // Cash IN/OUT come from the per-leg ledger (order_payments), NOT orders.payment_method — a split
  // bill records a cash leg + a card leg, so cash-half-of-a-split and unsettled partial cash are now
  // counted (CASH-1). Positive 'payment' legs = collected; negative 'refund' legs = paid back out.
  // Fallback (defense-in-depth): a paid order with NO leg at all — a raw insert, or a boot before the
  // backfill ran — is synthesized from payment_method so no money is ever silently dropped. NOT
  // EXISTS keeps it from double-counting an order that already has a leg.
  const legCash = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM order_payments
    WHERE method='cash' AND kind='payment' AND branch_id=? AND at >= ?`).get(branchId, sinceAt).v || 0;
  const noLegCash = db.prepare(`SELECT COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS v FROM orders o
    WHERE o.payment_method='cash' AND o.paid_at IS NOT NULL AND o.branch_id=? AND o.paid_at >= ?
      AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='payment')`).get(branchId, sinceAt).v || 0;
  const cashIn = legCash + noLegCash;
  const legRefund = db.prepare(`SELECT COALESCE(-SUM(amount),0) AS v FROM order_payments
    WHERE method='cash' AND kind='refund' AND branch_id=? AND at >= ?`).get(branchId, sinceAt).v || 0;
  const noLegRefund = db.prepare(`SELECT COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS v FROM orders o
    WHERE o.void_kind='refund' AND o.payment_method='cash' AND o.branch_id=? AND o.voided_at >= ?
      AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='refund')`).get(branchId, sinceAt).v || 0;
  const cashRefund = legRefund + noLegRefund;
  // Manual drawer movements in the window: pay_in adds cash, pay_out removes it.
  const payIn = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM cash_moves WHERE kind='pay_in' AND branch_id=? AND at >= ?`).get(branchId, sinceAt).v || 0;
  const payOut = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM cash_moves WHERE kind='pay_out' AND branch_id=? AND at >= ?`).get(branchId, sinceAt).v || 0;
  // ALL cash taken this Bangkok day, regardless of when the round was opened. cashIn only counts
  // sales made AFTER the round opened; the difference is money rung up before the round existed —
  // the single most common reason "over/short" looks wrong (owner opened the round mid-day).
  const dayCashLeg = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM order_payments
    WHERE method='cash' AND kind='payment' AND branch_id=? AND date(at,'+7 hours')=date('now','+7 hours')`).get(branchId).v || 0;
  const dayCashNoLeg = db.prepare(`SELECT COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS v FROM orders o
    WHERE o.payment_method='cash' AND o.paid_at IS NOT NULL AND o.branch_id=? AND date(o.paid_at,'+7 hours')=date('now','+7 hours')
      AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='payment')`).get(branchId).v || 0;
  const dayCash = dayCashLeg + dayCashNoLeg;
  const preRoundCash = r2(Math.max(0, dayCash - cashIn));
  return { cashIn: r2(cashIn), cashRefund: r2(cashRefund), payIn: r2(payIn), payOut: r2(payOut), dayCash: r2(dayCash), preRoundCash };
}
/** Add a manual cash drawer movement (pay-in / pay-out). */
export function addCashMove(branchId = 1, kind, amount, remark = null, actorId = null) {
  const k = kind === 'pay_out' ? 'pay_out' : 'pay_in';
  const a = Math.round((Number(amount) || 0) * 100) / 100;
  if (!(a > 0)) throw new Error('bad_amount');
  const info = db.prepare('INSERT INTO cash_moves (branch_id, kind, amount, remark, actor_id) VALUES (?,?,?,?,?)')
    .run(branchId, k, a, remark ? String(remark).slice(0, 120) : null, actorId);
  return db.prepare('SELECT * FROM cash_moves WHERE id=?').get(info.lastInsertRowid);
}
/** Pay-in/out ledger for one Bangkok-local day (default today) — for the cash screen's day view. */
export function listCashMoves(branchId = 1, date = null) {
  const day = date || db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const rows = db.prepare(
    `SELECT cm.id, cm.kind, cm.amount, cm.remark, cm.at, s.name AS actor_name
       FROM cash_moves cm LEFT JOIN staff s ON s.id=cm.actor_id
      WHERE cm.branch_id=? AND date(cm.at,'+7 hours')=? ORDER BY cm.at DESC`
  ).all(branchId, day);
  const payIn = r2(rows.filter((r) => r.kind === 'pay_in').reduce((s, r) => s + r.amount, 0));
  const payOut = r2(rows.filter((r) => r.kind === 'pay_out').reduce((s, r) => s + r.amount, 0));
  return { date: day, moves: rows, payIn, payOut, net: r2(payIn - payOut) };
}
export function deleteCashMove(id, branchId = 1, actorId = null) {
  // Owner decision 2026-07: deletions must show in ควบคุมการลดยอด — snapshot the row into the
  // immutable sale_events audit trail BEFORE it disappears from the ledger.
  const row = db.prepare('SELECT * FROM cash_moves WHERE id=? AND branch_id=?').get(Number(id), branchId);
  if (row) logSaleEvent({ branchId, type: 'cash_delete', amount: row.amount, actor: actorId,
    meta: { kind: row.kind, remark: row.remark || null, movedAt: row.at } });
  db.prepare('DELETE FROM cash_moves WHERE id=? AND branch_id=?').run(Number(id), branchId);
  return { ok: true };
}
/** Total pay-out for a Bangkok day — deducted from that day's revenue in reports. */
export function payOutForDay(branchId = 1, date = null) {
  const day = date || db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  return r2(db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM cash_moves WHERE kind='pay_out' AND branch_id=? AND date(at,'+7 hours')=?`).get(branchId, day).v || 0);
}
/** Owner anti-fraud view: every revenue-REDUCING action for a Bangkok-local day
 *  (void / waste / discount) with WHO did it + ฿ value, plus per-staff & per-type totals.
 *  Plus standalone counter reward-redeems. Pure read over the immutable sale_events trail. */
export function listReductions(branchId = 1, date = null) {
  const day = date || db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const rows = db.prepare(
    `SELECT se.id, se.type, se.amount, se.meta, se.at, se.ticket_id,
            COALESCE(s.name,'—') AS staff, t.number AS ticket_no, t.customer_name
       FROM sale_events se
       LEFT JOIN staff s ON s.id=se.actor
       LEFT JOIN tickets t ON t.id=se.ticket_id
      WHERE se.branch_id=? AND se.type IN ('void','waste','discount','cash_delete')
        AND date(se.at,'+7 hours')=? ORDER BY se.at DESC`
  ).all(branchId, day);
  const events = rows.map((r) => {
    let reason = null;
    try {
      const m = r.meta ? JSON.parse(r.meta) : null;
      // cash_delete: describe the removed ledger row (รับเข้า/จ่ายออก + its remark)
      reason = m ? (m.reason || (r.type === 'cash_delete'
        ? `ลบรายการ${m.kind === 'pay_in' ? 'รับเข้า' : 'จ่ายออก'}${m.remark ? ' — ' + m.remark : ''}` : null)) : null;
    } catch { /* keep null */ }
    return { id: r.id, type: r.type, amount: r2(r.amount || 0), at: r.at, staff: r.staff,
      ticketNo: r.ticket_no || null, customer: r.customer_name || null, reason };
  });
  const sumType = (t) => r2(events.filter((e) => e.type === t).reduce((s, e) => s + e.amount, 0));
  const byType = { void: sumType('void'), waste: sumType('waste'), discount: sumType('discount'), cash_delete: sumType('cash_delete') };
  const byStaffMap = {};
  for (const e of events) byStaffMap[e.staff] = r2((byStaffMap[e.staff] || 0) + e.amount);
  const byStaff = Object.entries(byStaffMap).map(([staff, amount]) => ({ staff, amount })).sort((a, b) => b.amount - a.amount);
  let redeems = [];
  try {
    redeems = db.prepare(
      `SELECT lm.at, lm.note, lm.points, COALESCE(c.name, lm.customer_key) AS customer
         FROM loyalty_moves lm LEFT JOIN customers c ON c.line_user_id=lm.customer_key
        WHERE lm.kind='redeem' AND date(lm.at,'+7 hours')=? ORDER BY lm.at DESC`
    ).all(day);
  } catch { /* loyalty optional */ }
  return { date: day, events, byType, byStaff, redeems, count: events.length, total: r2(byType.void + byType.waste + byType.discount) };
}
/** Current open cash session for a branch (+ live expected cash so far). */
export function currentCashSession(branchId = 1) {
  const s = db.prepare('SELECT * FROM cash_sessions WHERE branch_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1').get(branchId);
  if (!s) return { open: false };
  const c = cashComponents(branchId, s.opened_at);
  return { open: true, session: s, ...c, expectedCash: r2(s.open_float + c.cashIn - c.cashRefund + c.payIn - c.payOut) };
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
  const expected = r2(cur.open_float + c.cashIn - c.cashRefund + c.payIn - c.payOut);
  const counted = r2(countedCash);
  const over = r2(counted - expected);
  db.prepare(`UPDATE cash_sessions SET closed_by=?, closed_at=datetime('now'), counted_cash=?, expected_cash=?, over_short=?, note=? WHERE id=?`)
    .run(actorId, counted, expected, over, note ? note.toString().slice(0, 200) : null, cur.id);
  const out = { session: db.prepare('SELECT * FROM cash_sessions WHERE id=?').get(cur.id), openFloat: cur.open_float, ...c, expectedCash: expected, countedCash: counted, overShort: over, zreport: detailedReports({ branchId }) };
  // Closing the drawer = end of day → optionally LINE the owner a full closing summary (once/day).
  // All three are fire-and-forget so a slow/failing LINE call can never hold up (or fail) a cash
  // close. They now AWAIT the push internally, which is what matters: the "already sent today"
  // marker is only written on a real delivery, so a rejected push retries on the next close instead
  // of being recorded as done. Nothing reads summarySent/reorderDrafted, so no result is lost here.
  try { Promise.resolve(maybeAutoSummary(branchId)).catch(() => {}); } catch { /* never block a close */ }
  try { Promise.resolve(maybeAutoReorder(branchId)).catch(() => {}); } catch { /* never block a close */ }
  try { Promise.resolve(maybeAutoWinback(branchId)).catch(() => {}); } catch { /* never block a close */ }
  return out;
}

/** Closed cash rounds (Z-report history), newest first, + a 12-month rollup — the owner asked for
 *  day-by-day rounds that stay browsable daily OR aggregated monthly. lastFloat powers the
 *  "same float as last round" one-tap when opening the next round. */
export function cashSessionHistory(branchId = 1, limit = 60) {
  const rows = db.prepare(
    `SELECT cs.id, cs.open_float, cs.expected_cash, cs.counted_cash, cs.over_short, cs.note,
            cs.opened_at, cs.closed_at,
            date(cs.closed_at,'+7 hours') AS day,
            so.name AS opened_by_name, sc.name AS closed_by_name
       FROM cash_sessions cs
       LEFT JOIN staff so ON so.id=cs.opened_by
       LEFT JOIN staff sc ON sc.id=cs.closed_by
      WHERE cs.branch_id=? AND cs.closed_at IS NOT NULL
      ORDER BY cs.id DESC LIMIT ?`
  ).all(branchId, Math.max(1, Math.min(365, limit)));
  const monthly = db.prepare(
    `SELECT substr(datetime(closed_at,'+7 hours'),1,7) ym, COUNT(*) rounds,
            COALESCE(SUM(expected_cash),0) expected, COALESCE(SUM(counted_cash),0) counted,
            COALESCE(SUM(over_short),0) overShort
       FROM cash_sessions WHERE branch_id=? AND closed_at IS NOT NULL
      GROUP BY ym ORDER BY ym DESC LIMIT 12`
  ).all(branchId).map((m) => ({ ...m, expected: r2(m.expected), counted: r2(m.counted), overShort: r2(m.overShort) }));
  return { sessions: rows, monthly, lastFloat: rows.length ? rows[0].open_float : null };
}
/** Full detail of ONE past round so the owner can open it and see everything that made the
 *  over/short — the tender mix collected DURING the round, the cash components, and the
 *  denomination note. Scoped to the round's own [opened_at, closed_at] window. */
export function cashSessionDetail(branchId, sessionId) {
  const s = db.prepare(
    `SELECT cs.*, date(cs.closed_at,'+7 hours') AS day, so.name AS opened_by_name, sc.name AS closed_by_name
       FROM cash_sessions cs LEFT JOIN staff so ON so.id=cs.opened_by LEFT JOIN staff sc ON sc.id=cs.closed_by
      WHERE cs.id=? AND cs.branch_id=?`
  ).get(Number(sessionId), branchId);
  if (!s) throw new Error('session_not_found');
  const until = s.closed_at || db.prepare("SELECT datetime('now') t").get().t;
  // Every tender taken while this round was open, grouped by method (what was in the drawer +
  // what came in electronically), so the round's money is fully explained after the fact.
  // Per-leg ledger: a split bill contributes to EACH method it used (payment legs +, refund legs −),
  // so cash-half-of-a-split shows under cash and card-half under card — not the whole bill under the
  // last method (the split-tender reconciliation bug).
  const payments = db.prepare(
    `SELECT method, COUNT(DISTINCT order_id) AS orders, COALESCE(SUM(amount),0) AS amount FROM (
        SELECT method, order_id, amount FROM order_payments WHERE branch_id=? AND at >= ? AND at <= ?
        UNION ALL
        SELECT COALESCE(o.payment_method,'other'), o.id, ROUND(o.total-COALESCE(o.discount,0),2)
          FROM orders o WHERE o.payment_status='paid' AND o.branch_id=? AND o.paid_at >= ? AND o.paid_at <= ?
            AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='payment')
        UNION ALL
        SELECT COALESCE(o.payment_method,'other'), o.id, -ROUND(o.total-COALESCE(o.discount,0),2)
          FROM orders o WHERE o.void_kind='refund' AND o.branch_id=? AND o.voided_at >= ? AND o.voided_at <= ?
            AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='refund')
      ) GROUP BY method HAVING amount <> 0 ORDER BY amount DESC`
  ).all(branchId, s.opened_at, until, branchId, s.opened_at, until, branchId, s.opened_at, until).map((p) => ({ ...p, amount: r2(p.amount) }));
  const moves = db.prepare(
    `SELECT kind, amount, remark, at FROM cash_moves WHERE branch_id=? AND at >= ? AND at <= ? ORDER BY at`
  ).all(branchId, s.opened_at, until);
  return { session: s, payments, moves, reconciliation: tenderReconciliation(s, payments) };
}
// A tender is "auto-reconciled" only if the till physically proves it — that's cash (you count the
// drawer). Every electronic channel needs the owner to check its own statement, so it starts as an
// open reconciling item until a real received-amount is keyed in.
const TENDER_LABELS = { cash: 'เงินสด', promptpay: 'พร้อมเพย์', kplus: 'K PLUS', '6040': 'เป๋าตัง/คนละครึ่ง', online: 'ออนไลน์', slip: 'สลิปโอน', linepay: 'LINE Pay', reward: 'แลกแต้ม', other: 'อื่นๆ' };
/** Reconcile one round's tenders: system-recorded (book) vs actually-received (statement/drawer),
 *  with the difference per channel. Cash is settled by the drawer count; e-channels carry the
 *  owner-entered actual. `expected` is ALWAYS recomputed here — a stored actual can never silently
 *  drift the book side. */
export function tenderReconciliation(session, payments) {
  const saved = (() => { try { return JSON.parse(session.recon_json || '{}'); } catch { return {}; } })();
  const lines = (payments || []).map((p) => {
    const method = p.method || 'other';
    const expected = r2(p.amount);
    if (method === 'cash') {
      // The drawer IS the statement for cash: what the round should hold vs what was counted.
      const actual = session.counted_cash != null ? r2(session.counted_cash) : null;
      const expDrawer = r2(session.expected_cash);
      return { method, label: TENDER_LABELS.cash, expected: expDrawer, actual, diff: actual != null ? r2(actual - expDrawer) : null, auto: true, note: 'นับจากลิ้นชัก', reconciled: actual != null };
    }
    const rec = saved[method] || {};
    const actual = rec.actual != null ? r2(rec.actual) : null;
    return { method, label: TENDER_LABELS[method] || method, expected, actual, diff: actual != null ? r2(actual - expected) : null, auto: false, note: rec.note || '', reconciled: actual != null };
  });
  const sum = (k) => r2(lines.reduce((s, l) => s + (l[k] || 0), 0));
  const done = lines.filter((l) => l.reconciled);
  return {
    lines,
    totalExpected: sum('expected'),
    totalActual: done.length ? r2(done.reduce((s, l) => s + (l.actual || 0), 0)) : null,
    totalDiff: done.length ? r2(done.reduce((s, l) => s + (l.diff || 0), 0)) : null,
    openItems: lines.filter((l) => !l.reconciled).length,   // channels still needing a statement check
    reconciledBy: saved.by || null, reconciledAt: saved.at || null,
  };
}
/** Save the owner's actually-received amounts for a round's e-channels. Cash is ignored (the drawer
 *  count is the source of truth). Recomputes + returns the fresh reconciliation. */
export function saveTenderRecon(branchId, sessionId, { lines = [], actorId = null } = {}) {
  const s = db.prepare('SELECT * FROM cash_sessions WHERE id=? AND branch_id=?').get(Number(sessionId), branchId);
  if (!s) throw new Error('session_not_found');
  if (!s.closed_at) throw new Error('round_not_closed');
  const prev = (() => { try { return JSON.parse(s.recon_json || '{}'); } catch { return {}; } })();
  const out = { ...prev };
  for (const l of Array.isArray(lines) ? lines : []) {
    const m = String(l.method || '').trim();
    if (!m || m === 'cash') continue;              // cash is settled by the count, never keyed
    if (l.actual == null || l.actual === '') { delete out[m]; continue; }
    const a = Math.max(0, Number(l.actual) || 0);
    out[m] = { actual: r2(a), note: (l.note || '').toString().slice(0, 120) };
  }
  const actor = actorId ? db.prepare('SELECT name FROM staff WHERE id=?').get(actorId) : null;
  out.by = actor?.name || null;
  out.at = db.prepare("SELECT datetime('now','+7 hours') t").get().t;
  db.prepare('UPDATE cash_sessions SET recon_json=? WHERE id=?').run(JSON.stringify(out), s.id);
  const detail = cashSessionDetail(branchId, s.id);
  return detail.reconciliation;
}

/** Daily reset: clear all tickets and restart numbering from 0 in every zone. */
export function resetAllZones() {
  // Fires at 00:00 Bangkok, so the day that just ended is "yesterday". Archive its totals, then
  // restart the queue counters. Tickets/orders are NOT deleted — they persist for history and
  // every report is date-filtered. (The old code DELETEd tickets, which hit a FK error against
  // orders and rolled the whole reset back, so numbers never restarted and "today" accumulated.)
  const ended = db.prepare(`SELECT date('now','+7 hours','-1 day') AS d`).get().d;
  archiveTodaySales(ended); // sales_history row for the day that just ended
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO daily_stats (date, zone_id, issued, served, no_shows, avg_wait_sec, avg_rating)
       SELECT ?, z.id,
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.number>0 AND date(t.numbered_at,'+7 hours')=?),
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served'  AND date(t.closed_at,'+7 hours')=?),
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show' AND date(t.closed_at,'+7 hours')=?),
         (SELECT CAST(AVG((julianday(called_at)-julianday(created_at))*86400) AS INTEGER) FROM tickets t WHERE t.zone_id=z.id AND t.called_at IS NOT NULL AND date(t.created_at,'+7 hours')=?),
         (SELECT AVG(rating) FROM tickets t WHERE t.zone_id=z.id AND t.rating IS NOT NULL AND date(t.created_at,'+7 hours')=?)
       FROM zones z`
    ).run(ended, ended, ended, ended, ended, ended);
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
 *  so the customer LIFF shows "closed" everywhere. Returns affected zone ids.
 *  Closing remembers which zones were already closed on purpose (zone_was_open in settings), so
 *  reopening the store restores only the zones that were open — a zone shut for repairs stays shut. */
export function setStoreOpen(storeId, isOpen) {
  const v = isOpen ? 1 : 0;
  db.prepare('UPDATE stores SET is_open=? WHERE id=?').run(v, storeId);
  if (!v) {
    const openIds = db.prepare('SELECT id FROM zones WHERE store_id=? AND is_open=1').all(storeId).map((z) => z.id);
    setSetting(`store:${storeId}:zones_were_open`, JSON.stringify(openIds));
    db.prepare('UPDATE zones SET is_open=0 WHERE store_id=?').run(storeId);
  } else {
    let remembered = null;
    try { remembered = JSON.parse(getSetting(`store:${storeId}:zones_were_open`, 'null')); } catch { /* fall through */ }
    if (Array.isArray(remembered) && remembered.length) {
      for (const id of remembered) db.prepare('UPDATE zones SET is_open=1 WHERE id=? AND store_id=?').run(id, storeId);
    } else {
      db.prepare('UPDATE zones SET is_open=1 WHERE store_id=?').run(storeId);   // nothing remembered → open all (old behaviour)
    }
    setSetting(`store:${storeId}:zones_were_open`, '');
  }
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
  const rows = db.prepare('SELECT id, name, name_en, price, image, category, active, soldout, sort, badge FROM menu_items ORDER BY sort, id').all();
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
  // Lifetime "sold" per item from PAID orders. Drink lines carry a " · หวาน X%" suffix, so match on the base name.
  try {
    const soldMap = new Map();
    for (const s of db.prepare(
      `SELECT CASE WHEN instr(oi.name,' · ')>0 THEN substr(oi.name,1,instr(oi.name,' · ')-1) ELSE oi.name END AS base, SUM(oi.qty) q
         FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.payment_status='paid' GROUP BY base`
    ).all()) soldMap.set(s.base, s.q);
    rows.forEach((r) => { r.sold = soldMap.get(r.name) || 0; });
  } catch (e) { rows.forEach((r) => { r.sold = 0; }); }
  // "Likes" = DISTINCT identifiable customers who either BOUGHT the item (paid order) or tapped
  // the ❤️ themselves (menu_likes). UNION + COUNT DISTINCT so a buyer who also taps counts once.
  // Honest social proof: never zero for anything that actually sells, and un-fakeable at scale.
  try {
    const likeMap = new Map();
    for (const s of db.prepare(
      `SELECT base, COUNT(DISTINCT cust) AS n FROM (
         SELECT CASE WHEN instr(oi.name,' · ')>0 THEN substr(oi.name,1,instr(oi.name,' · ')-1) ELSE oi.name END AS base,
                COALESCE(t.line_user_id, t.customer_key) AS cust
           FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN tickets t ON t.id=o.ticket_id
          WHERE o.payment_status='paid'
         UNION
         SELECT mi.name AS base, ml.customer_key AS cust
           FROM menu_likes ml JOIN menu_items mi ON mi.id=ml.menu_item_id
       ) WHERE cust IS NOT NULL GROUP BY base`
    ).all()) likeMap.set(s.base, s.n);
    rows.forEach((r) => { r.likes = likeMap.get(r.name) || 0; });
  } catch (e) { rows.forEach((r) => { r.likes = 0; }); }
  return rows;
}
/** Toggle a customer's ❤️ on a menu item. Returns the new state + the merged display count. */
export function toggleMenuLike(menuItemId, customerKey) {
  const id = Number(menuItemId);
  const item = db.prepare('SELECT id, name FROM menu_items WHERE id=?').get(id);
  if (!item) throw new Error('item_not_found');
  const had = db.prepare('SELECT 1 FROM menu_likes WHERE menu_item_id=? AND customer_key=?').get(id, customerKey);
  if (had) db.prepare('DELETE FROM menu_likes WHERE menu_item_id=? AND customer_key=?').run(id, customerKey);
  else db.prepare('INSERT OR IGNORE INTO menu_likes (menu_item_id, customer_key) VALUES (?,?)').run(id, customerKey);
  const likes = db.prepare(
    `SELECT COUNT(DISTINCT cust) AS n FROM (
       SELECT COALESCE(t.line_user_id, t.customer_key) AS cust
         FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN tickets t ON t.id=o.ticket_id
        WHERE o.payment_status='paid'
          AND (CASE WHEN instr(oi.name,' · ')>0 THEN substr(oi.name,1,instr(oi.name,' · ')-1) ELSE oi.name END)=?
       UNION
       SELECT customer_key AS cust FROM menu_likes WHERE menu_item_id=?
     ) WHERE cust IS NOT NULL`
  ).get(item.name, id).n;
  return { liked: !had, likes };
}
/** Menu-item ids this customer has hearted (to paint the ❤️ filled on their screen). */
export function myMenuLikes(customerKey) {
  if (!customerKey) return [];
  return db.prepare('SELECT menu_item_id FROM menu_likes WHERE customer_key=?').all(customerKey).map((r) => r.menu_item_id);
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
export function recordStockMove(ingredientId, { kind, qty, cost = null, note = null, actorId = null, supplierId = null, expiry = null, poId = null } = {}) {
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
  const exp = (kind === 'purchase' && /^\d{4}-\d{2}-\d{2}$/.test(String(expiry || ''))) ? expiry : null;
  // Freeze the per-unit cost on the move (ACC-F1): a purchase carries its own unit price; a
  // consumption/adjustment is valued at the weighted-average cost AS IT STANDS NOW, so a later
  // purchase that shifts avg_cost can never re-price a day that was already closed.
  const unitCost = (kind === 'purchase')
    ? ((q > 0 && Number(cost) > 0) ? round2i(Number(cost) / q) : ing.avg_cost)
    : ing.avg_cost;
  const tx = db.transaction(() => {
    db.prepare('UPDATE ingredients SET stock_qty=?, avg_cost=? WHERE id=?').run(newStock, newAvg, ingredientId);
    db.prepare('INSERT INTO stock_moves (ingredient_id, branch_id, kind, qty, cost, unit_cost, note, actor, supplier_id, expiry, po_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(ingredientId, ing.branch_id, kind, moveQty, kind === 'purchase' ? (Number(cost) || null) : null, unitCost, note ? note.toString().slice(0, 200) : null, actorId,
        kind === 'purchase' ? (Number(supplierId) || null) : null, exp, kind === 'purchase' ? (Number(poId) || null) : null);
  });
  tx();
  return db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
}
export function stockMoves(ingredientId, limit = 50) {
  return db.prepare('SELECT * FROM stock_moves WHERE ingredient_id=? ORDER BY id DESC LIMIT ?').all(ingredientId, limit);
}

// ---------- Suppliers (ร้านค้า/ผู้ขาย) + purchase planning ----------
export function listSuppliers() {
  return db.prepare('SELECT * FROM suppliers WHERE active=1 ORDER BY name').all();
}
export function upsertSupplier(id, { name, phone = null, note = null, active = 1 } = {}) {
  const n = (name || '').toString().trim().slice(0, 60);
  if (id) {
    const cur = db.prepare('SELECT id FROM suppliers WHERE id=?').get(id);
    if (!cur) throw new Error('supplier_not_found');
    db.prepare('UPDATE suppliers SET name=COALESCE(NULLIF(?,\'\'),name), phone=?, note=?, active=? WHERE id=?')
      .run(n, phone ? String(phone).slice(0, 30) : null, note ? String(note).slice(0, 200) : null, active ? 1 : 0, id);
    return db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  }
  if (!n) throw new Error('name_required');
  const r = db.prepare('INSERT INTO suppliers (name, phone, note) VALUES (?,?,?)')
    .run(n, phone ? String(phone).slice(0, 30) : null, note ? String(note).slice(0, 200) : null);
  return db.prepare('SELECT * FROM suppliers WHERE id=?').get(r.lastInsertRowid);
}
/** Purchase price history for one ingredient: when, from whom, at what unit price — the
 *  owner's "ซื้อกับใคร เมื่อไหร่ ราคาเท่าไหร่" answer, newest first. */
export function ingredientPriceHistory(ingredientId, limit = 20) {
  return db.prepare(
    `SELECT sm.at, sm.qty, sm.cost, s.name AS supplier
       FROM stock_moves sm LEFT JOIN suppliers s ON s.id=sm.supplier_id
      WHERE sm.ingredient_id=? AND sm.kind='purchase' AND sm.qty>0 AND sm.cost>0
      ORDER BY sm.id DESC LIMIT ?`
  ).all(ingredientId, limit).map((r) => ({
    at: r.at, qty: r.qty, cost: r.cost, supplier: r.supplier || null,
    unitPrice: r2(r.cost / r.qty),
  }));
}
/** Purchase plan: for every active ingredient, burn rate from the last 14 days of 'use'
 *  moves → days of stock left → suggested order qty to cover the NEXT 14 days (+ safety
 *  = low_threshold), with the last supplier/price so the owner knows who to call. */
export function purchasePlan(horizonDays = 14) {
  const items = db.prepare('SELECT * FROM ingredients WHERE active=1 ORDER BY name').all();
  return items.map((ing) => {
    const used = db.prepare(
      `SELECT SUM(-qty) u FROM stock_moves
        WHERE ingredient_id=? AND kind='use' AND at >= datetime('now','-14 days')`
    ).get(ing.id)?.u || 0;
    const perDay = r2(used / 14);
    const daysLeft = perDay > 0 ? Math.floor(ing.stock_qty / perDay) : null;   // null = no usage data
    const need = perDay > 0 ? Math.max(0, r2(perDay * horizonDays + ing.low_threshold - ing.stock_qty)) : 0;
    const lastBuy = db.prepare(
      `SELECT sm.at, sm.qty, sm.cost, s.name AS supplier
         FROM stock_moves sm LEFT JOIN suppliers s ON s.id=sm.supplier_id
        WHERE sm.ingredient_id=? AND sm.kind='purchase' AND sm.qty>0
        ORDER BY sm.id DESC LIMIT 1`
    ).get(ing.id);
    return {
      id: ing.id, name: ing.name, unit: ing.unit, stock: ing.stock_qty, low: ing.stock_qty <= ing.low_threshold,
      perDay, daysLeft, suggestQty: need > 0 ? Math.ceil(need) : 0,
      estCost: need > 0 && lastBuy?.cost > 0 && lastBuy?.qty > 0 ? r2(Math.ceil(need) * (lastBuy.cost / lastBuy.qty)) : null,
      lastSupplier: lastBuy?.supplier || null,
      lastUnitPrice: lastBuy?.cost > 0 && lastBuy?.qty > 0 ? r2(lastBuy.cost / lastBuy.qty) : null,
      lastBuyAt: lastBuy?.at || null,
    };
  }).sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
}

// ========== SCM: purchase orders, two-way sourcing views, expiry lots ==========
/** By-ingredient sourcing: which suppliers we've bought this from + each one's latest/avg
 *  unit price + times bought. Answers "รายการนี้เคยซื้อจากใครบ้าง ราคาเท่าไหร่" (multi-source). */
export function ingredientSources(ingredientId) {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id=?').get(ingredientId);
  if (!ing) throw new Error('ingredient_not_found');
  const rows = db.prepare(
    `SELECT COALESCE(s.name,'ไม่ระบุผู้ขาย') supplier, sm.supplier_id,
            COUNT(*) times, SUM(sm.qty) qty, SUM(sm.cost) spent, MAX(sm.at) lastAt
       FROM stock_moves sm LEFT JOIN suppliers s ON s.id=sm.supplier_id
      WHERE sm.ingredient_id=? AND sm.kind='purchase' AND sm.qty>0 AND sm.cost>0
      GROUP BY sm.supplier_id ORDER BY lastAt DESC`
  ).all(ingredientId);
  const sources = rows.map((r) => ({
    supplierId: r.supplier_id || null, supplier: r.supplier, times: r.times,
    avgUnit: r.qty > 0 ? r2(r.spent / r.qty) : 0, lastAt: r.lastAt,
  }));
  const cheapest = sources.filter((s) => s.avgUnit > 0).sort((a, b) => a.avgUnit - b.avgUnit)[0] || null;
  return { ingredient: { id: ing.id, name: ing.name, unit: ing.unit, stock: ing.stock_qty, avgCost: ing.avg_cost },
    sources, cheapest, history: ingredientPriceHistory(ingredientId, 30) };
}
/** By-supplier catalog: what this supplier has sold us, each item's latest unit price +
 *  total spent, plus their purchase-order history. Answers "เจ้านี้ขายอะไร ราคาเท่าไหร่". */
export function supplierCatalog(supplierId) {
  const sup = db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!sup) throw new Error('supplier_not_found');
  const items = db.prepare(
    `SELECT i.id, i.name, i.unit, COUNT(*) times, SUM(sm.qty) qty, SUM(sm.cost) spent,
            MAX(sm.at) lastAt
       FROM stock_moves sm JOIN ingredients i ON i.id=sm.ingredient_id
      WHERE sm.supplier_id=? AND sm.kind='purchase' AND sm.qty>0 AND sm.cost>0
      GROUP BY i.id ORDER BY lastAt DESC`
  ).all(supplierId).map((r) => ({ id: r.id, name: r.name, unit: r.unit, times: r.times,
    avgUnit: r.qty > 0 ? r2(r.spent / r.qty) : 0, spent: r2(r.spent), lastAt: r.lastAt }));
  const orders = db.prepare(
    `SELECT po.id, po.po_no, po.status, po.ordered_at, po.received_at,
            COUNT(l.id) lines, COALESCE(SUM(l.qty*l.unit_price),0) total
       FROM purchase_orders po LEFT JOIN purchase_order_lines l ON l.po_id=po.id
      WHERE po.supplier_id=? GROUP BY po.id ORDER BY po.id DESC LIMIT 30`
  ).all(supplierId).map((r) => ({ ...r, total: r2(r.total) }));
  return { supplier: sup, items, orders, totalSpent: r2(items.reduce((s, i) => s + i.spent, 0)) };
}
/** Lots (purchase moves that carry an expiry) expiring within `days` — FEFO heads-up.
 *  NOTE: this is a received-lot expiry alert, not remaining-qty-per-lot depletion tracking. */
export function expiringLots(days = 14) {
  const rows = db.prepare(
    `SELECT sm.id, sm.expiry, sm.qty, sm.at, i.name, i.unit, s.name AS supplier
       FROM stock_moves sm JOIN ingredients i ON i.id=sm.ingredient_id
       LEFT JOIN suppliers s ON s.id=sm.supplier_id
      WHERE sm.kind='purchase' AND sm.expiry IS NOT NULL
        AND date(sm.expiry) <= date('now','+7 hours',? )
      ORDER BY sm.expiry ASC`
  ).all(`+${Math.max(0, Number(days) || 14)} days`);
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  return rows.map((r) => ({ id: r.id, name: r.name, unit: r.unit, qty: r.qty, expiry: r.expiry,
    supplier: r.supplier || null, boughtAt: r.at,
    daysLeft: Math.round((Date.parse(r.expiry) - Date.parse(today)) / 86400000),
    expired: r.expiry < today }));
}
// ---- Purchase orders (ใบสั่งซื้อ) ----
function poView(id) {
  const po = db.prepare(
    `SELECT po.*, s.name AS supplier_name, st.name AS actor_name FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id=po.supplier_id LEFT JOIN staff st ON st.id=po.actor WHERE po.id=?`
  ).get(id);
  if (!po) return null;
  const lines = db.prepare(
    `SELECT l.*, i.name AS ingredient_name, i.unit FROM purchase_order_lines l
       JOIN ingredients i ON i.id=l.ingredient_id WHERE l.po_id=? ORDER BY l.id`
  ).all(id).map((l) => ({ ...l, lineTotal: r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)) }));
  return { ...po, lines, total: r2(lines.reduce((s, l) => s + l.lineTotal, 0)) };
}
export function getPurchaseOrder(id) { return poView(id); }
export function listPurchaseOrders({ supplierId = null, status = null, limit = 40 } = {}) {
  const where = [], args = [];
  if (supplierId) { where.push('po.supplier_id=?'); args.push(Number(supplierId)); }
  if (status) { where.push('po.status=?'); args.push(String(status)); }
  const rows = db.prepare(
    `SELECT po.id, po.po_no, po.status, po.ordered_at, po.received_at, s.name AS supplier_name,
            COUNT(l.id) lines, COALESCE(SUM(l.qty*l.unit_price),0) total
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id
       LEFT JOIN purchase_order_lines l ON l.po_id=po.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY po.id ORDER BY po.id DESC LIMIT ?`
  ).all(...args, limit);
  return rows.map((r) => ({ ...r, total: r2(r.total) }));
}
function nextPoNo() {
  const y = db.prepare("SELECT strftime('%Y', datetime('now','+7 hours')) y").get().y;
  const n = (db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE po_no LIKE ?").get(`PO-${y}-%`).c || 0) + 1;
  return `PO-${y}-${String(n).padStart(4, '0')}`;
}
/** Create/replace a DRAFT purchase order (header + lines). Received POs are immutable. */
export function savePurchaseOrder({ id = null, supplierId = null, poNo = null, note = null, lines = [], actorId = null } = {}) {
  const clean = (Array.isArray(lines) ? lines : []).map((l) => ({
    ingredientId: Number(l.ingredientId) || 0, qty: Math.max(0, Number(l.qty) || 0),
    unitPrice: Math.max(0, Number(l.unitPrice) || 0),
    expiry: /^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry || '')) ? l.expiry : null,
    note: l.note ? String(l.note).slice(0, 120) : null,
  })).filter((l) => l.ingredientId && l.qty > 0);
  const tx = db.transaction(() => {
    let poId = id;
    if (poId) {
      const cur = db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(poId);
      if (!cur) throw new Error('po_not_found');
      if (cur.status !== 'draft') throw new Error('po_not_editable');
      db.prepare('UPDATE purchase_orders SET supplier_id=?, po_no=?, note=? WHERE id=?')
        .run(supplierId ? Number(supplierId) : null, (poNo || '').toString().slice(0, 30) || null, note ? String(note).slice(0, 200) : null, poId);
      db.prepare('DELETE FROM purchase_order_lines WHERE po_id=?').run(poId);
    } else {
      const info = db.prepare('INSERT INTO purchase_orders (po_no, supplier_id, note, actor) VALUES (?,?,?,?)')
        .run((poNo || nextPoNo()).toString().slice(0, 30), supplierId ? Number(supplierId) : null, note ? String(note).slice(0, 200) : null, actorId);
      poId = info.lastInsertRowid;
    }
    const ins = db.prepare('INSERT INTO purchase_order_lines (po_id, ingredient_id, qty, unit_price, expiry, note) VALUES (?,?,?,?,?,?)');
    for (const l of clean) ins.run(poId, l.ingredientId, l.qty, l.unitPrice, l.expiry, l.note);
    return poId;
  });
  return poView(tx());
}
/** Receive a draft PO: post every line as a purchase stock_move (on-hand + avg cost + expiry
 *  lot + supplier + po_id), then mark received. Idempotent-guarded: a received PO can't re-post. */
export function receivePurchaseOrder(id, { actorId = null } = {}) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);
  if (!po) throw new Error('po_not_found');
  if (po.status !== 'draft') throw new Error('po_not_draft');
  const lines = db.prepare('SELECT * FROM purchase_order_lines WHERE po_id=?').all(id);
  if (!lines.length) throw new Error('po_empty');
  for (const l of lines) {
    recordStockMove(l.ingredient_id, { kind: 'purchase', qty: l.qty, cost: r2(l.qty * l.unit_price),
      note: `รับเข้าจากใบสั่งซื้อ ${po.po_no || ('#' + po.id)}`, actorId, supplierId: po.supplier_id, expiry: l.expiry, poId: po.id });
  }
  db.prepare("UPDATE purchase_orders SET status='received', received_at=datetime('now'), actor=COALESCE(?,actor) WHERE id=?").run(actorId, id);
  return poView(id);
}
export function cancelPurchaseOrder(id) {
  const po = db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(id);
  if (!po) throw new Error('po_not_found');
  if (po.status === 'received') throw new Error('po_already_received');
  db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=?").run(id);
  return { ok: true };
}
/** Fuzzy-match OCR'd receipt line names to existing ingredients. PURE + testable — no I/O.
 *  parsedLines: [{name, qty, unitPrice, expiry}] · ingredients: [{id,name,unit}].
 *  Returns each line with the best ingredient match (or ingredientId:null = needs manual pick). */
const aliasNorm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[.,()]/g, '');
export function matchReceiptLines(parsedLines = [], ingredients = [], aliases = {}) {
  const idx = ingredients.map((i) => ({ i, n: aliasNorm(i.name) }));
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  return (Array.isArray(parsedLines) ? parsedLines : []).map((l) => {
    const n = aliasNorm(l.name);
    let hit = null, viaAlias = false;
    // 1) learned alias (the owner matched this exact wording before) wins outright
    if (n && aliases && aliases[n] != null && byId.has(aliases[n])) { hit = { i: byId.get(aliases[n]) }; viaAlias = true; }
    if (!hit && n) {
      hit = idx.find((x) => x.n === n)                                   // exact name
        || idx.find((x) => x.n.includes(n) || n.includes(x.n))          // substring either way
        || idx.find((x) => { const a = new Set(String(l.name).toLowerCase().split(/\s+/).filter(Boolean));
            return [...a].some((w) => w.length >= 3 && x.n.includes(aliasNorm(w))); }); // token overlap
    }
    return {
      name: String(l.name || '').slice(0, 60),
      ingredientId: hit ? hit.i.id : null,
      matchedName: hit ? hit.i.name : null,
      qty: Math.max(0, Number(l.qty) || 0),
      unitPrice: Math.max(0, Number(l.unitPrice) || 0),
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry || '')) ? l.expiry : null,
      matched: !!hit, viaAlias,
    };
  });
}
/** Current learned OCR aliases as a {normText: ingredientId} map (drops any pointing at a
 *  deleted ingredient). Fed into matchReceiptLines so remembered wordings auto-match. */
export function aliasMap() {
  const out = {};
  for (const r of db.prepare('SELECT alias_norm, ingredient_id FROM ingredient_aliases').all()) {
    if (db.prepare('SELECT 1 FROM ingredients WHERE id=?').get(r.ingredient_id)) out[r.alias_norm] = r.ingredient_id;
  }
  return out;
}
/** Teach the OCR: remember that receipt text `text` means ingredient `ingredientId`.
 *  Upsert on the normalized text so a corrected mapping overwrites the old one. */
export function learnAlias(text, ingredientId) {
  const norm = aliasNorm(text); const id = Number(ingredientId) || 0;
  if (!norm || !id) return { ok: false };
  if (!db.prepare('SELECT 1 FROM ingredients WHERE id=?').get(id)) throw new Error('ingredient_not_found');
  db.prepare(`INSERT INTO ingredient_aliases (alias_norm, ingredient_id) VALUES (?,?)
              ON CONFLICT(alias_norm) DO UPDATE SET ingredient_id=excluded.ingredient_id`).run(norm, id);
  return { ok: true };
}
export function learnAliases(pairs = []) {
  let n = 0; for (const p of (Array.isArray(pairs) ? pairs : [])) { try { if (learnAlias(p.text, p.ingredientId).ok) n++; } catch { /* skip bad */ } }
  return { learned: n };
}
/** Purchasing report over a Bangkok date range: monthly rollup + per-item + per-supplier spend,
 *  from the immutable purchase stock_moves ledger. Answers ซื้อไปเท่าไหร่ ต่อรายการ / ต่อ supplier. */
export function purchaseSummary(from = null, to = null) {
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from
    : db.prepare("SELECT date(datetime('now','+7 hours'),'-365 days') d").get().d;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : today;
  const WHERE = `sm.kind='purchase' AND sm.qty>0 AND sm.cost>0 AND date(sm.at,'+7 hours') BETWEEN ? AND ?`;
  const byMonth = db.prepare(
    `SELECT substr(date(sm.at,'+7 hours'),1,7) ym, COUNT(*) lines, SUM(sm.qty) qty, SUM(sm.cost) spent
       FROM stock_moves sm WHERE ${WHERE} GROUP BY ym ORDER BY ym DESC`
  ).all(f, t).map((r) => ({ ym: r.ym, lines: r.lines, qty: r2(r.qty), spent: r2(r.spent) }));
  const byItem = db.prepare(
    `SELECT i.name, i.unit, COUNT(*) times, SUM(sm.qty) qty, SUM(sm.cost) spent
       FROM stock_moves sm JOIN ingredients i ON i.id=sm.ingredient_id WHERE ${WHERE}
      GROUP BY sm.ingredient_id ORDER BY spent DESC`
  ).all(f, t).map((r) => ({ name: r.name, unit: r.unit, times: r.times, qty: r2(r.qty), spent: r2(r.spent),
    avgUnit: r.qty > 0 ? r2(r.spent / r.qty) : 0 }));
  const bySupplier = db.prepare(
    `SELECT COALESCE(s.name,'ไม่ระบุผู้ขาย') supplier, COUNT(*) times, SUM(sm.cost) spent
       FROM stock_moves sm LEFT JOIN suppliers s ON s.id=sm.supplier_id WHERE ${WHERE}
      GROUP BY sm.supplier_id ORDER BY spent DESC`
  ).all(f, t).map((r) => ({ supplier: r.supplier, times: r.times, spent: r2(r.spent) }));
  return { from: f, to: t, total: r2(byItem.reduce((s, r) => s + r.spent, 0)), byMonth, byItem, bySupplier };
}
export function ocrConfigured() { return !!(process.env.OCR_API_URL && process.env.OCR_API_KEY); }
/** Call the configured vision endpoint to read a purchase receipt/invoice image into structured
 *  lines. DORMANT until OCR_API_URL + OCR_API_KEY are set (owner adds them in Render, like SlipOK).
 *  Returns { supplier, lines:[{name,qty,unitPrice,expiry}] }. Never trusted blindly — the UI makes
 *  the owner review + match every line before the PO is saved. */
export async function parseReceiptImage(dataUrl) {
  if (!ocrConfigured()) throw new Error('ocr_off');
  const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('bad_image');
  const prompt = 'อ่านใบรายการซื้อ/ใบเสร็จวัตถุดิบนี้ ตอบเป็น JSON เท่านั้น: '
    + '{"supplier":"ชื่อร้าน","lines":[{"name":"ชื่อสินค้า","qty":จำนวน,"unitPrice":ราคาต่อหน่วย,"expiry":"YYYY-MM-DD หรือ null"}]}. '
    + 'ห้ามมีข้อความอื่นนอก JSON.';
  const r = await fetch(process.env.OCR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OCR_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OCR_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
      max_tokens: 1500,
    }),
  });
  if (!r.ok) throw new Error('ocr_failed');
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '';
  const jm = text.match(/\{[\s\S]*\}/);
  if (!jm) throw new Error('ocr_unparsed');
  const parsed = JSON.parse(jm[0]);
  return { supplier: parsed.supplier || null, lines: Array.isArray(parsed.lines) ? parsed.lines : [] };
}
/** Turn the purchase plan into a DRAFT PO of everything that needs reordering (one-tap). */
export function draftPoFromPlan({ actorId = null } = {}) {
  const need = purchasePlan().filter((p) => p.suggestQty > 0);
  if (!need.length) return null;
  return savePurchaseOrder({ actorId, note: 'สร้างจากคำแนะนำการสั่งซื้อ',
    lines: need.map((p) => ({ ingredientId: p.id, qty: p.suggestQty, unitPrice: p.lastUnitPrice || 0 })) });
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
/** Per-menu margin: sell price vs BOM cost (สูตร × ต้นทุนถัวเฉลี่ยของวัตถุดิบ), ranked by margin.
 *  Items without a recipe show cost 0 + hasRecipe:false so the owner can see what's un-costed. */
export function menuMargins() {
  const items = db.prepare(`SELECT id, name, price, category FROM menu_items WHERE active=1 ORDER BY price DESC`).all();
  return items.map((it) => {
    const parts = db.prepare(
      `SELECT r.qty, i.name AS ing, i.unit, i.avg_cost FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.menu_item_id=?`
    ).all(it.id);
    const cost = r2(parts.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.avg_cost) || 0), 0));
    const margin = r2(it.price - cost);
    return { id: it.id, name: it.name, category: it.category, price: it.price, cost, margin,
      marginPct: it.price > 0 ? r2((margin / it.price) * 100) : 0, hasRecipe: parts.length > 0,
      parts: parts.map((p) => ({ ing: p.ing, qty: p.qty, unit: p.unit, cost: r2((p.qty || 0) * (p.avg_cost || 0)) })) };
  }).sort((a, b) => b.margin - a.margin);
}
/** REAL ingredient cost for a Bangkok day from the stock ledger: use moves (auto-deducted on every
 *  paid sale) net of returns (cancelled/not-made), valued at each ingredient's CURRENT weighted-avg
 *  cost — an approximation (moves don't snapshot unit cost), stated as such in the UI. */
export function cogsForDay(date = null) {
  const day = date || db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  // Value consumption at the cost FROZEN on each move (COALESCE to the ingredient's current avg only
  // for un-backfilled legacy rows), NOT the live avg_cost — so buying stock after a day closed can no
  // longer restate that day's COGS (ACC-F1). Sum per row (each carries its own unit_cost).
  const rows = db.prepare(
    `SELECT sm.qty q, COALESCE(sm.unit_cost, i.avg_cost) uc
       FROM stock_moves sm JOIN ingredients i ON i.id=sm.ingredient_id
      WHERE date(sm.at,'+7 hours')=? AND sm.kind IN ('use','return')`
  ).all(day);
  // use rows carry negative qty (deduction); return rows positive — netting both gives real consumption.
  const cogs = rows.reduce((s, r) => s + (-(Number(r.q) || 0)) * (Number(r.uc) || 0), 0);
  const wasteRows = db.prepare(
    `SELECT SUM(-sm.qty * COALESCE(sm.unit_cost, i.avg_cost)) v FROM stock_moves sm JOIN ingredients i ON i.id=sm.ingredient_id
      WHERE date(sm.at,'+7 hours')=? AND sm.kind='waste'`
  ).get(day);
  return { date: day, cogsActual: r2(Math.max(0, cogs)), wasteCost: r2(Math.max(0, wasteRows?.v || 0)) };
}
/** Auto-deduct ingredient stock for every line of a paid order, per its menu item's recipe.
 *  No-op for any line whose menu item has no recipe → safe/dormant until recipes are set. */
function deductStockForOrder(order) {
  try {
    const items = db.prepare('SELECT name, qty, menu_item_id FROM order_items WHERE order_id=?').all(order.id);
    const code = db.prepare('SELECT code FROM tickets WHERE id=?').get(order.ticket_id)?.code || ('#' + order.id);
    for (const it of items) {
      // The stored menu_item_id survives a menu RENAME (the name-match below silently stops
      // deducting stock the day an item is renamed); name is only the fallback for legacy rows.
      let miId = it.menu_item_id;
      if (!miId) {
        const base = String(it.name).split(' · ')[0];   // strip the " · หวาน X%" suffix
        miId = db.prepare('SELECT id FROM menu_items WHERE name=? LIMIT 1').get(base)?.id;
      }
      if (!miId) continue;
      const recipe = db.prepare('SELECT ingredient_id, qty FROM recipes WHERE menu_item_id=?').all(miId);
      for (const r of recipe) {
        const use = (Number(r.qty) || 0) * (Number(it.qty) || 1);
        if (use > 0) try {
          const before = db.prepare('SELECT stock_qty, low_threshold, name, unit FROM ingredients WHERE id=?').get(r.ingredient_id);
          const after = recordStockMove(r.ingredient_id, { kind: 'use', qty: use, note: 'ขายอัตโนมัติ ' + code });
          // Notify the owner the moment a sale pushes an ingredient to/under its low mark.
          if (before && before.low_threshold > 0 && before.stock_qty > before.low_threshold && after.stock_qty <= before.low_threshold)
            // Deliberately not awaited — a low-stock alert must never delay or fail a sale. Caught
            // so the now-async notifyOwner can't raise an unhandled rejection.
            Promise.resolve(notifyOwner(`⚠️ วัตถุดิบใกล้หมด: ${before.name} เหลือ ${after.stock_qty} ${before.unit}`)).catch(() => {});
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
  const rows = db.prepare('SELECT id, name, role, active, hourly_rate FROM staff ORDER BY role, name').all();
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
export function updateStaff(id, { name, role, active, pin, branchIds, hourlyRate }) {
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
  const hr = hourlyRate != null ? Math.max(0, Number(hourlyRate) || 0) : (cur.hourly_rate || 0);
  db.prepare('UPDATE staff SET name=?, role=?, active=?, pin_hash=?, hourly_rate=? WHERE id=?').run(n, r, a, pinHash, hr, id);
  if (Array.isArray(branchIds)) {
    db.prepare('DELETE FROM staff_branches WHERE staff_id=?').run(id);
    if (r !== 'owner') for (const b of branchIds) db.prepare('INSERT OR IGNORE INTO staff_branches (staff_id, branch_id) VALUES (?,?)').run(id, b);
  }
  return { id: Number(id), name: n, role: r, active: a, hourly_rate: hr, branchIds: r === 'owner' ? [] : branchIdsOf(id) };
}

// ---------- Time clock ----------
// The prorated monthly wage in the cost settings is a PLAN. This records what a day actually cost:
// who was on, for how long, at the rate they were on at the time. A day with clocked shifts uses
// the real number in the P&L; a day without falls back to the plan, so nothing changes until the
// shop starts using the clock.
export function openShift(staffId) {
  const s = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(staffId);
  if (!s) throw new Error('staff_not_found');
  const open = db.prepare('SELECT * FROM staff_shifts WHERE staff_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(staffId);
  if (open) return { ...open, already: true };            // idempotent: re-tapping "เข้างาน" never double-opens
  const id = db.prepare('INSERT INTO staff_shifts (staff_id, rate) VALUES (?,?)').run(staffId, s.hourly_rate || 0).lastInsertRowid;
  return db.prepare('SELECT * FROM staff_shifts WHERE id=?').get(id);
}
export function closeShift(staffId, note = null) {
  const open = db.prepare('SELECT * FROM staff_shifts WHERE staff_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(staffId);
  if (!open) throw new Error('no_open_shift');
  db.prepare("UPDATE staff_shifts SET clock_out=datetime('now'), note=? WHERE id=?").run(note || null, open.id);
  const row = db.prepare("SELECT *, (julianday(clock_out)-julianday(clock_in))*24 AS hours FROM staff_shifts WHERE id=?").get(open.id);
  const cost = Math.round(Math.max(0, row.hours) * (row.rate || 0) * 100) / 100;
  db.prepare('UPDATE staff_shifts SET cost=? WHERE id=?').run(cost, open.id);
  return { ...row, cost, hours: Math.round(row.hours * 100) / 100 };
}
export function openShiftOf(staffId) {
  if (!staffId) return null;
  return db.prepare('SELECT * FROM staff_shifts WHERE staff_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(staffId) || null;
}
/** Shifts that STARTED on a Bangkok day, newest first, with the person's name. */
export function shiftsForDay(dateStr = null) {
  const day = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `'${dateStr}'` : `date('now','+7 hours')`;
  return db.prepare(
    `SELECT sh.*, st.name AS staff_name,
            (julianday(COALESCE(sh.clock_out, datetime('now')))-julianday(sh.clock_in))*24 AS hours
       FROM staff_shifts sh JOIN staff st ON st.id=sh.staff_id
      WHERE date(sh.clock_in,'+7 hours')=${day}
      ORDER BY sh.clock_in DESC`
  ).all().map((r) => ({ ...r, hours: Math.round(r.hours * 100) / 100, open: !r.clock_out }));
}
/** What the day's labour actually cost. Only CLOSED shifts count — an open one is still running. */
export function laborActual(dateStr = null) {
  const day = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `'${dateStr}'` : `date('now','+7 hours')`;
  const r = db.prepare(
    `SELECT COUNT(*) AS shifts, COALESCE(SUM(cost),0) AS cost,
            COALESCE(SUM((julianday(clock_out)-julianday(clock_in))*24),0) AS hours
       FROM staff_shifts WHERE clock_out IS NOT NULL AND date(clock_in,'+7 hours')=${day}`
  ).get();
  const openN = db.prepare(
    `SELECT COUNT(*) n FROM staff_shifts WHERE clock_out IS NULL AND date(clock_in,'+7 hours')=${day}`
  ).get().n;
  return { shifts: r.shifts, openShifts: openN, cost: Math.round(r.cost * 100) / 100, hours: Math.round(r.hours * 100) / 100 };
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
/** Owner adds a new payment tender (channel). kind: counter (cashier collects) | online (customer app). */
export function addTender({ code, label, kind = 'counter', fee_pct = 0 } = {}) {
  const lb = (label || '').toString().trim().slice(0, 40);
  if (!lb) throw new Error('label_required');
  let cd = (code || '').toString().trim().replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || ('t' + Date.now());
  if (db.prepare('SELECT 1 FROM tenders WHERE code=?').get(cd)) cd = cd + Date.now().toString().slice(-4);
  const k = kind === 'online' ? 'online' : 'counter';
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM tenders').get().m;
  const info = db.prepare('INSERT INTO tenders (code, label, kind, fee_pct, active, sort) VALUES (?,?,?,?,1,?)')
    .run(cd, lb, k, Math.max(0, Math.min(100, Number(fee_pct) || 0)), maxSort + 1);
  return db.prepare('SELECT * FROM tenders WHERE id=?').get(info.lastInsertRowid);
}
/** Owner removes a tender. (Historical sales keep their pay-method string; this only affects the picker.) */
export function deleteTender(id) { db.prepare('DELETE FROM tenders WHERE id=?').run(Number(id)); return { ok: true }; }

// ---------- Coupons (validated + priced SERVER-SIDE = anti-fraud) ----------
function _couponByCode(code) { return db.prepare('SELECT * FROM coupons WHERE code=? COLLATE NOCASE').get((code || '').toString().trim()); }
export function listCoupons(includeInactive = false) {
  return db.prepare(`SELECT * FROM coupons ${includeInactive ? '' : 'WHERE active=1'} ORDER BY created_at DESC, id DESC`).all();
}
export function createCoupon(c = {}) {
  const code = (c.code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 24);
  if (!code) throw new Error('code_required');
  if (_couponByCode(code)) throw new Error('code_exists');
  const label = (c.label || '').toString().trim().slice(0, 60) || code;
  const type = c.disc_type === 'percent' ? 'percent' : 'baht';
  // percent is capped at 100 — a typo like "500%" otherwise silently means "free order"
  const value = Math.min(type === 'percent' ? 100 : 1e7, Math.max(0, Number(c.disc_value) || 0));
  const info = db.prepare(`INSERT INTO coupons (code,label,disc_type,disc_value,max_disc,min_spend,valid_from,expires_at,usage_limit,per_customer,stackable,audience,valid_days,active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(code, label,
      type, value,
      Math.max(0, Number(c.max_disc) || 0), Math.max(0, Number(c.min_spend) || 0),
      (c.valid_from || null) && String(c.valid_from).slice(0, 10),
      (c.expires_at || null) && String(c.expires_at).slice(0, 10),
      Math.max(0, parseInt(c.usage_limit) || 0), Math.max(0, parseInt(c.per_customer ?? 1)), c.stackable ? 1 : 0, c.audience === 'new' ? 'new' : 'all',
      // days-after-receipt expiry — used by claim links AND targeted sends (sendCampaign reads it)
      Math.max(0, Math.min(365, parseInt(c.valid_days) || 0)));
  return db.prepare('SELECT * FROM coupons WHERE id=?').get(info.lastInsertRowid);
}
export function updateCoupon(id, c = {}) {
  const cur = db.prepare('SELECT * FROM coupons WHERE id=?').get(id); if (!cur) throw new Error('coupon_not_found');
  const g = (k, d) => (c[k] != null ? c[k] : d);
  const newType = c.disc_type === 'percent' ? 'percent' : (c.disc_type === 'baht' ? 'baht' : cur.disc_type);
  db.prepare(`UPDATE coupons SET label=?,disc_type=?,disc_value=?,max_disc=?,min_spend=?,valid_from=?,expires_at=?,usage_limit=?,per_customer=?,stackable=?,audience=?,valid_days=?,active=? WHERE id=?`)
    .run((g('label', cur.label) || '').toString().slice(0, 60), newType,
      Math.min(newType === 'percent' ? 100 : 1e7, Math.max(0, Number(g('disc_value', cur.disc_value)) || 0)), Math.max(0, Number(g('max_disc', cur.max_disc)) || 0),
      Math.max(0, Number(g('min_spend', cur.min_spend)) || 0),
      (c.valid_from !== undefined ? (c.valid_from ? String(c.valid_from).slice(0, 10) : null) : cur.valid_from),
      (c.expires_at !== undefined ? (c.expires_at ? String(c.expires_at).slice(0, 10) : null) : cur.expires_at),
      Math.max(0, parseInt(g('usage_limit', cur.usage_limit)) || 0), Math.max(0, parseInt(g('per_customer', cur.per_customer))),
      c.stackable != null ? (c.stackable ? 1 : 0) : cur.stackable, (c.audience != null ? (c.audience === 'new' ? 'new' : 'all') : (cur.audience || 'all')),
      Math.max(0, Math.min(365, parseInt(g('valid_days', cur.valid_days)) || 0)),
      c.active != null ? (c.active ? 1 : 0) : cur.active, id);
  return db.prepare('SELECT * FROM coupons WHERE id=?').get(id);
}
export function deleteCoupon(id) { db.prepare('DELETE FROM coupons WHERE id=?').run(Number(id)); return { ok: true }; }
// ---------- Coupon scoping (which menu items a coupon applies to) + audience ----------
export function couponItems(couponId) {
  return db.prepare('SELECT ref_type, ref_value FROM coupon_items WHERE coupon_id=? ORDER BY ref_type, ref_value').all(Number(couponId));
}
/** Replace a coupon's scope. rows = [{refType:'menu_item'|'category', refValue}]; empty = whole order. */
export function setCouponItems(couponId, rows = []) {
  const id = Number(couponId);
  if (!db.prepare('SELECT 1 FROM coupons WHERE id=?').get(id)) throw new Error('coupon_not_found');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM coupon_items WHERE coupon_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO coupon_items (coupon_id, ref_type, ref_value) VALUES (?,?,?)');
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const t = r.refType === 'category' ? 'category' : 'menu_item';
      const v = String(r.refValue || '').trim().slice(0, 60);
      if (v) ins.run(id, t, v);
    }
  });
  tx();
  return couponItems(id);
}
/** The ฿ base a scoped coupon discounts: the matching lines only. No scope rows → the whole order.
 *  lines = [{name, price, qty}]; a drink name may carry a " · หวาน X%" suffix, so match on the base name. */
function scopedBase(couponId, lines, orderNet) {
  const scope = couponItems(couponId);
  if (!scope.length) return { base: orderNet, scoped: false };
  if (!Array.isArray(lines)) return { base: null, scoped: true };   // caller can't prove eligibility
  const names = new Set(scope.filter((s) => s.ref_type === 'menu_item').map((s) => s.ref_value));
  const cats = new Set(scope.filter((s) => s.ref_type === 'category').map((s) => s.ref_value));
  let base = 0;
  for (const l of lines) {
    const bare = String(l.name || '').split(' · ')[0];
    let hit = names.has(bare);
    if (!hit && cats.size) {
      const cat = db.prepare('SELECT category FROM menu_items WHERE name=? LIMIT 1').get(bare)?.category;
      hit = !!cat && cats.has(cat);
    }
    if (hit) base += (Number(l.price) || 0) * (Number(l.qty) || 1);
  }
  return { base: r2(Math.min(base, orderNet)), scoped: true };
}
/** Audience gate: 'new' campaigns are for customers with no paid order yet (acquisition offers). */
function audienceOK(coupon, customerKey) {
  if (!coupon.audience || coupon.audience === 'all') return true;
  if (!customerKey) return false;                       // can't prove they're new → don't hand it out
  const paid = db.prepare(
    `SELECT COUNT(*) n FROM orders o JOIN tickets t ON t.id=o.ticket_id
      WHERE o.payment_status='paid' AND (t.line_user_id=? OR t.customer_key=?)`
  ).get(customerKey, customerKey).n;
  return paid === 0;
}
// ---------- Claim campaigns: a link customers tap to COLLECT a coupon into their wallet ----------
function randToken(n = 18) {
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';   // no look-alikes; high entropy beats guessable codes
  let s = ''; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
/** Turn a coupon into a claim campaign (or update its claim settings). Returns the coupon incl. token. */
export function setCouponClaim(id, { issueLimit = 0, claimStart = null, claimEnd = null, validDays = 0, enable = true } = {}) {
  const cur = db.prepare('SELECT * FROM coupons WHERE id=?').get(id);
  if (!cur) throw new Error('coupon_not_found');
  if (!enable) { db.prepare("UPDATE coupons SET distribution='code' WHERE id=?").run(id); return db.prepare('SELECT * FROM coupons WHERE id=?').get(id); }
  const token = cur.claim_token || randToken();
  const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
  db.prepare(`UPDATE coupons SET distribution='claim', claim_token=?, issue_limit=?, claim_start=?, claim_end=?, valid_days=? WHERE id=?`)
    .run(token, Math.max(0, parseInt(issueLimit) || 0), d(claimStart), d(claimEnd), Math.max(0, parseInt(validDays) || 0), id);
  return db.prepare('SELECT * FROM coupons WHERE id=?').get(id);
}
/** Public view of a claim link — powers the landing page BEFORE the customer taps รับคูปอง. */
/** Count one OPEN of the claim landing page (interest stat). Separate from claimInfo so internal
 *  calls (claimCoupon's pre-check) never inflate the number — only the GET route counts. */
export function recordClaimView(token) {
  try { db.prepare("UPDATE coupons SET view_count = view_count + 1 WHERE claim_token=? AND distribution='claim'").run(String(token || '')); } catch { /* stat only */ }
}
export function claimInfo(token, customerKey = null) {
  const c = db.prepare("SELECT * FROM coupons WHERE claim_token=? AND distribution='claim'").get(String(token || ''));
  if (!c) return { state: 'not_found' };
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const base = {
    label: c.label, discType: c.disc_type, discValue: c.disc_value, minSpend: c.min_spend,
    maxDisc: c.max_disc, expiresAt: c.expires_at, validDays: c.valid_days,
    limit: c.issue_limit, claimed: c.issued_count,
    remaining: c.issue_limit > 0 ? Math.max(0, c.issue_limit - c.issued_count) : null,
  };
  if (customerKey && db.prepare('SELECT 1 FROM customer_coupons WHERE coupon_id=? AND customer_key=?').get(c.id, customerKey)) return { ...base, state: 'already' };
  if (!c.active) return { ...base, state: 'closed' };
  if (customerKey && !audienceOK(c, customerKey)) return { ...base, state: 'not_eligible' };
  if (c.claim_start && today < c.claim_start) return { ...base, state: 'not_started' };
  if (c.claim_end && today > c.claim_end) return { ...base, state: 'ended' };
  if (c.expires_at && today > c.expires_at) return { ...base, state: 'ended' };
  if (c.issue_limit > 0 && c.issued_count >= c.issue_limit) return { ...base, state: 'sold_out' };
  return { ...base, state: 'claimable' };
}
/** Collect the coupon into the customer's wallet. Quota is taken ATOMICALLY, and the unique index
 *  on (coupon_id, customer_key) is what actually prevents a double claim under concurrency. */
export function claimCoupon(token, customerKey) {
  if (!customerKey) throw new Error('no_customer');
  const c = db.prepare("SELECT * FROM coupons WHERE claim_token=? AND distribution='claim'").get(String(token || ''));
  if (!c) return { ok: false, state: 'not_found' };
  const pre = claimInfo(token, customerKey);
  if (pre.state !== 'claimable') return { ok: false, state: pre.state, ...pre };
  // 1) take one unit of the quota — the predicate is evaluated inside the UPDATE, so the last
  //    unit cannot be handed to two racers.
  const took = db.prepare(
    'UPDATE coupons SET issued_count = issued_count + 1 WHERE id=? AND active=1 AND (issue_limit<=0 OR issued_count < issue_limit)'
  ).run(c.id);
  if (!took.changes) return { ok: false, state: 'sold_out' };
  // 2) write the wallet row; the UNIQUE index rejects a second claim → hand the quota back.
  const expiresAt = c.valid_days > 0
    ? db.prepare(`SELECT date(datetime('now','+7 hours'),'+' || ? || ' days') d`).get(c.valid_days).d
    : (c.expires_at || db.prepare(`SELECT date(datetime('now','+7 hours'),'+30 days') d`).get().d);
  try {
    const ccId = db.prepare(`INSERT INTO customer_coupons (customer_key, coupon_id, kind, label, free_cap, expires_at, source)
                             VALUES (?,?, 'claim', ?, ?, ?, 'claim_link')`)
      .run(customerKey, c.id, c.label, c.disc_type === 'percent' ? (c.max_disc || 0) : c.disc_value, expiresAt).lastInsertRowid;
    return { ok: true, state: 'claimed', id: Number(ccId), label: c.label, expiresAt };
  } catch {
    db.prepare('UPDATE coupons SET issued_count = MAX(0, issued_count - 1) WHERE id=?').run(c.id);
    return { ok: false, state: 'already' };
  }
}
/** Validate a coupon for a customer + order net → the ONE source of truth (re-run on payment). */
export function validateCoupon(code, customerKey, orderNet, lines = null) {
  const c = _couponByCode(code); orderNet = Math.max(0, Number(orderNet) || 0);
  if (!c) return { ok: false, reason: 'ไม่พบคูปองนี้' };
  if (!c.active) return { ok: false, reason: 'คูปองถูกปิดใช้งาน' };
  // A claim-link coupon is quota-controlled: it may ONLY be spent from the wallet of a customer who
  // collected it via the link. Honouring the raw code here would let anyone who saw the code bypass
  // the quota — and let a claimer double-dip (wallet voucher + this code discount on top).
  if (c.distribution === 'claim') return { ok: false, reason: 'คูปองนี้ต้องกดรับผ่านลิงก์ก่อน แล้วใช้จาก "คูปองของฉัน"' };
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  if (c.valid_from && c.valid_from > today) return { ok: false, reason: `คูปองเริ่มใช้ได้ ${c.valid_from}` };
  if (c.expires_at && c.expires_at < today) return { ok: false, reason: 'คูปองหมดอายุแล้ว' };
  if (orderNet < c.min_spend) return { ok: false, reason: `ใช้ได้เมื่อยอด ≥ ฿${c.min_spend}` };
  if (c.usage_limit > 0 && c.used_count >= c.usage_limit) return { ok: false, reason: 'คูปองถูกใช้ครบแล้ว' };
  if (c.per_customer > 0 && customerKey) {
    const used = db.prepare('SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id=? AND customer_key=?').get(c.id, customerKey).n;
    if (used >= c.per_customer) return { ok: false, reason: 'คุณใช้คูปองนี้ครบสิทธิ์แล้ว' };
  }
  if (!audienceOK(c, customerKey)) return { ok: false, reason: 'คูปองนี้สำหรับลูกค้าใหม่เท่านั้น' };
  // Scoped coupons discount ONLY the matching lines. Without the lines we cannot prove eligibility,
  // so we refuse rather than risk discounting the whole bill.
  const { base, scoped } = scopedBase(c.id, lines, orderNet);
  if (scoped && base == null) return { ok: false, reason: 'ใช้ได้เฉพาะบางเมนู' };
  if (scoped && base <= 0) return { ok: false, reason: 'ไม่มีเมนูที่ร่วมรายการในตะกร้า' };
  let disc = c.disc_type === 'percent' ? (base * c.disc_value / 100) : c.disc_value;
  if (c.disc_type === 'percent' && c.max_disc > 0) disc = Math.min(disc, c.max_disc);
  disc = Math.min(r2(disc), base);   // a fixed-baht coupon can never exceed the eligible items' value
  return { ok: true, discount: disc, couponId: c.id, code: c.code, label: c.label, stackable: !!c.stackable, scoped };
}
/** Coupons a customer can see for their current order (each with eligibility + computed discount). */
/** Owner policy: a completed stamp card (10 ดวง) is CONVERTED into 1 coupon on the spot — the
 *  stamps are spent at conversion, and the coupon is good for 30 days. Expiry kills the coupon
 *  only (never claws back other stamps). Runs lazily and idempotently: loops while the balance
 *  still covers a card, so multi-card balances convert fully and pre-existing balances convert
 *  the first time the customer's coupons are looked at. */
export function convertReadyRewards(customerKey) {
  if (!customerKey || !loyaltyEnabled()) return [];
  const issued = [];
  for (;;) {
    const bal = loyaltyBalance(customerKey).points;
    const reward = db.prepare('SELECT * FROM rewards WHERE active=1 AND cost_points<=? ORDER BY cost_points DESC, id LIMIT 1').get(bal);
    if (!reward) break;
    const tpl = couponTemplate('reward');
    const expiresAt = db.prepare(`SELECT date(datetime('now','+7 hours'),'+' || ? || ' days') d`).get(tpl.days).d;
    let ccId = null;
    db.transaction(() => {
      db.prepare('UPDATE customers SET points = points - ? WHERE line_user_id=?').run(reward.cost_points, customerKey);
      db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, note) VALUES (?, 'redeem', ?, ?)`)
        .run(customerKey, -reward.cost_points, 'สะสมครบ → แลกเป็นคูปอง: ' + reward.name);
      ccId = db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'reward', ?, ?, ?, 'reward')`)
        .run(customerKey, reward.name, tpl.value, expiresAt).lastInsertRowid;
    })();
    issued.push({ id: Number(ccId), label: reward.name, expiresAt });
  }
  return issued;
}
/** A customer's live (unused, unexpired) coupons — stamp-card conversions + birthday gifts. */
export function customerCoupons(customerKey) {
  if (!customerKey) return [];
  return db.prepare(
    `SELECT * FROM customer_coupons
      WHERE customer_key=? AND used_at IS NULL AND state != 'cancelled' AND expires_at >= date('now','+7 hours')
      ORDER BY expires_at, id`
  ).all(customerKey);
}
export function availableCoupons(customerKey, orderNet, lines = null) {
  // Claim-link coupons never appear in the public code list: the quota lives at the link, and a
  // customer who claimed already sees their voucher via the wallet rows unshifted below.
  const list = listCoupons(false).filter((c) => c.distribution !== 'claim').map((c) => { const v = validateCoupon(c.code, customerKey, orderNet, lines);
    return { id: c.id, code: c.code, label: c.label, disc_type: c.disc_type, disc_value: c.disc_value, max_disc: c.max_disc,
      min_spend: c.min_spend, expires_at: c.expires_at, usable: v.ok, discount: v.ok ? v.discount : 0, reason: v.ok ? null : v.reason }; });
  // A stamp-card reward the customer has already earned shows up in the SAME coupon list, so they
  // can pick it like any other discount — one tap in the cart applies it as a free-drink discount
  // (redeemRewardOnOrder re-checks their balance server-side at order time, so this is advisory only).
  if (customerKey) {
    // Convert any full stamp cards first (lazy, covers balances earned before this feature), then
    // surface every live coupon the customer holds — reward conversions and birthday gifts alike.
    try { convertReadyRewards(customerKey); } catch { /* never block the coupon list */ }
    for (const cc of customerCoupons(customerKey).reverse()) {
      list.unshift({ id: 'cc-' + cc.id, code: 'CCOUP:' + cc.id, label: cc.label, disc_type: 'reward',
        disc_value: 0, max_disc: 0, min_spend: 0, expires_at: cc.expires_at, usable: true, discount: 0, reason: null,
        isReward: true, ccId: cc.id, freeCap: cc.free_cap, couponKind: cc.kind });
    }
  }
  // CUS-H6: surface what's usable NOW. Order = the customer's earned rewards, then usable coupons
  // (biggest discount first), then anything not-yet-usable (expired / min-spend / used up) at the
  // bottom — a valuable usable coupon must never sit buried below an expired one. Array.sort is
  // stable in V8, so rewards keep their claim order and unusable rows keep newest-first.
  const rank = (c) => (c.usable ? (c.isReward ? 0 : 1) : 2);
  list.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return (b.discount || 0) - (a.discount || 0);
    return 0;
  });
  return list;
}
/** Apply a coupon to an order at creation: re-validate SERVER-SIDE, add its discount (respecting any
 *  existing free-giveaway discount + the coupon's stackable flag), record the use, bump used_count. */
export function applyCouponToOrder(ticketId, code, customerKey = null) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  const existing = Math.max(0, Number(order.discount) || 0);
  const orderLines = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id=?').all(order.id);
  const v = validateCoupon(code, customerKey, order.total, orderLines);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (existing > 0 && !v.stackable) return { ok: false, reason: 'ใช้ร่วมกับส่วนลดอื่นไม่ได้' };
  const couponDisc = Math.min(v.discount, Math.max(0, order.total - existing));
  if (couponDisc <= 0) return { ok: false, reason: 'ไม่มีส่วนลดที่ใช้ได้' };
  const totalDisc = r2(existing + couponDisc);
  const reason = (order.discount_reason ? order.discount_reason + ' + ' : '') + 'คูปอง ' + v.code;
  // Claim the redemption ATOMICALLY before touching the order. validateCoupon() read used_count a
  // moment ago; between that read and here another till could have taken the last use. The predicate
  // is evaluated inside the UPDATE, so two racers can never both take the final redemption.
  // …and all three writes commit together: taking the redemption without recording the discount
  // charged the customer full price for a coupon they had just spent, and recording the discount
  // without the coupon_uses row let them use a once-per-customer coupon again.
  let claimedOK = true;
  db.transaction(() => {
    const claimed = db.prepare(
      'UPDATE coupons SET used_count = used_count + 1 WHERE id=? AND (usage_limit IS NULL OR usage_limit<=0 OR used_count < usage_limit)'
    ).run(v.couponId);
    if (!claimed.changes) { claimedOK = false; return; }
    db.prepare('UPDATE orders SET discount=?, discount_reason=? WHERE id=?').run(totalDisc, reason, order.id);
    db.prepare('INSERT INTO coupon_uses (coupon_id, order_id, customer_key, discount) VALUES (?,?,?,?)').run(v.couponId, order.id, customerKey, couponDisc);
  })();
  if (!claimedOK) return { ok: false, reason: 'คูปองถูกใช้ครบแล้ว' };
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'discount', amount: couponDisc, actor: null, meta: { coupon: v.code } });
  return { ok: true, discount: couponDisc, totalDiscount: totalDisc, code: v.code };
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
  // Net-of-discount takings per tender code, split across each method a bill actually used. Attributed
  // by the ORDER's paid_at day (JOIN to orders) — NOT the leg's own timestamp — so a bill partially
  // paid before midnight and settled after lands entirely on its settlement day, matching the revenue
  // report exactly. Only PAID orders' payment legs count (refunds are a separate report). Fallback
  // synthesizes a leg for any paid order that has none (raw insert / pre-backfill).
  const rows = db.prepare(
    `SELECT code, COUNT(DISTINCT order_id) AS orders, COALESCE(SUM(amount),0) AS amount FROM (
        SELECT p.method AS code, p.order_id, p.amount
          FROM order_payments p JOIN orders o ON o.id=p.order_id
         WHERE p.kind='payment' AND o.payment_status='paid' AND date(o.paid_at,'+7 hours') = ${DAY} AND (? IS NULL OR o.branch_id = ?)
        UNION ALL
        SELECT COALESCE(o.payment_method,'unspecified'), o.id, ROUND(o.total-COALESCE(o.discount,0),2)
          FROM orders o WHERE o.payment_status='paid' AND date(o.paid_at,'+7 hours') = ${DAY} AND (? IS NULL OR o.branch_id = ?)
            AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id=o.id AND p.kind='payment')
      ) GROUP BY code`
  ).all(date, branchId, branchId, date, branchId, branchId);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  const tenders = listTenders();
  const lines = tenders.map((t) => {
    const hit = byCode[t.code] || { orders: 0, amount: 0 };
    const amount = r2(hit.amount);
    const fee = r2(amount * (t.fee_pct || 0) / 100);
    return { code: t.code, label: t.label, kind: t.kind, fee_pct: t.fee_pct || 0,
             orders: hit.orders || 0, amount, fee, net: r2(amount - fee) };
  });
  // Orders paid via a code that isn't a registered tender (legacy promptpay/slip/other, or a
  // fully stamp-redeemed free order) still show up here, not lost — just labeled generically
  // by their raw code unless we give it a friendlier name (e.g. 'reward').
  const OTHER_LABELS = { reward: 'แลกด้วยแต้มสะสม (ฟรี)' };
  const known = new Set(tenders.map((t) => t.code));
  for (const r of rows) {
    if (!known.has(r.code)) {
      const amount = r2(r.amount);
      lines.push({ code: r.code, label: OTHER_LABELS[r.code] || r.code, kind: 'other', fee_pct: 0, orders: r.orders, amount, fee: 0, net: amount });
    }
  }
  const total = lines.reduce((a, l) => ({ orders: a.orders + l.orders, amount: r2(a.amount + l.amount), net: r2(a.net + l.net) }), { orders: 0, amount: 0, net: 0 });
  return { date, lines, total };
}

// ---------- Loyalty STAMP CARD (our own — LINE Reward Cards can't be awarded via API) ----------
// Model: 1 stamp per drink cup; collect `stamps_per_reward` cups → 1 free drink (≤49฿).
// "points" in the DB == stamps. Disabled by default (owner enables later).
export function loyaltyEnabled() { return getSetting('loyalty:enabled', '0') === '1'; }
// Phase 4A: the coupon-arrival popup — greet a customer who opens the LIFF holding an unused coupon
// with a branded card so it doesn't sit forgotten in the wallet. Owner-toggleable (default ON).
export function couponPopupEnabled() { return getSetting('coupon:popup', '1') === '1'; }
export function setCouponPopup(on) { setSetting('coupon:popup', on ? '1' : '0'); return { couponPopup: !!on }; }
export function setLoyaltyEnabled(on) { setSetting('loyalty:enabled', on ? '1' : '0'); return { enabled: !!on }; }
// Membership system (บัตรสมาชิก + tier + recognition) — SEPARATE from the stamp/points programme. Default ON.
export function memberEnabled() { return getSetting('member:enabled', '1') === '1'; }
export function setMemberEnabled(on) { setSetting('member:enabled', on ? '1' : '0'); return { memberEnabled: !!on }; }
// SlipOK auto-verify is an OWNER TOGGLE (default OFF) on top of the env creds, so the shop
// can run manual "attach slip → cashier confirms" until it has a PromptPay account SlipOK
// can verify against. Flip on (someday) only when a valid PromptPay merchant is configured.
// Slip OCR learn-as-you-correct: banks print the shop's receiver name differently (garbled by
// OCR too). When the cashier eyeballs a slip and confirms it's genuine, they can teach the
// reader the receiver text THAT bank prints; future scans match against these learned aliases
// on top of the built-in list. Stored as a JSON list in settings, deduped, capped.
export function listSlipAliases() {
  try { const a = JSON.parse(getSetting('slip:recv_aliases', '[]')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function addSlipAlias(text) {
  const t = String(text || '').trim().slice(0, 60);
  if (t.length < 3) throw new Error('alias_too_short');
  const cur = listSlipAliases();
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
  if (!cur.some((x) => norm(x) === norm(t))) {
    cur.push(t);
    setSetting('slip:recv_aliases', JSON.stringify(cur.slice(-30)));   // keep the latest 30
  }
  return { aliases: listSlipAliases() };
}
export function slipAutoEnabled() { return getSetting('slip:auto', '0') === '1'; }
// Owner-uploadable promo/ad splash shown in the LIFF after loading (a data-URL image the owner
// can change anytime in ⚙ จัดการ). enabled gates whether the customer actually sees it.
export function getPromo() { return { image: getSetting('promo:image', '') || '', enabled: getSetting('promo:enabled', '0') === '1' }; }
export function setPromo({ image, enabled } = {}) {
  if (image !== undefined) setSetting('promo:image', (image || '').toString().slice(0, 1500000));
  if (enabled !== undefined) setSetting('promo:enabled', enabled ? '1' : '0');
  return getPromo();
}
export function setSlipAuto(on) { setSetting('slip:auto', on ? '1' : '0'); return { slipAuto: !!on }; }
// Receipt printing prepared but DORMANT (default OFF) — owner flips on after wiring a printer.
export function printEnabled() { return getSetting('print:enabled', '0') === '1'; }
export function setPrintEnabled(on) { setSetting('print:enabled', on ? '1' : '0'); return { printEnabled: !!on }; }
// Social proof (owner-toggleable, default OFF): the LIFF shows "วันนี้ขายไปแล้ว N แก้ว" on the home.
// ---------- Full data backup ----------
// The shop's data lives on someone else's server. Excel reports cover the numbers but not the
// menu, recipes, stock, staff, customers or settings — so this dumps EVERY table as plain JSON
// the owner can keep. Read-only and self-describing: any of it can be rebuilt from this file.
// PIN hashes are stripped: a backup should never be a way to walk in with someone else's login.
const BACKUP_SKIP = new Set(['sqlite_sequence', 'push_log']);   // internals / high-volume logs
export function exportBackup() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name).filter((n) => !BACKUP_SKIP.has(n));
  const data = {};
  let rows = 0;
  for (const t of tables) {
    try {
      const list = db.prepare(`SELECT * FROM "${t}"`).all();
      data[t] = t === 'staff' ? list.map(({ pin_hash, ...rest }) => rest) : list;
      rows += list.length;
    } catch { data[t] = []; }   // a table the current build cannot read must not sink the whole backup
  }
  return {
    exportedAt: db.prepare("SELECT datetime('now','+7 hours') t").get().t,
    timezone: 'Asia/Bangkok', tables: tables.length, rows,
    note: 'YO-DEE full data backup · PIN hashes excluded on purpose',
    data,
  };
}

// ---------- PDPA: consent + right to erasure ----------
// Thai PDPA gives a customer the right to have their personal data deleted. Sales records are a
// different thing — they are accounting records the shop must keep. So this ANONYMISES rather
// than deletes: every identifier is stripped, the money stays. Irreversible on purpose.
export function recordConsent(customerKey) {
  if (!customerKey) return { ok: false };
  // A first-time visitor may consent BEFORE they ever order, so there is no customers row yet —
  // create the shell first, otherwise the consent silently lands nowhere. COALESCE keeps the
  // ORIGINAL date: re-tapping must never refresh the audit trail.
  db.prepare('INSERT OR IGNORE INTO customers (line_user_id) VALUES (?)').run(customerKey);
  db.prepare("UPDATE customers SET consent_at=COALESCE(consent_at, datetime('now')) WHERE line_user_id=?").run(customerKey);
  return { ok: true, at: db.prepare('SELECT consent_at FROM customers WHERE line_user_id=?').get(customerKey)?.consent_at || null };
}
export function consentGiven(customerKey) {
  if (!customerKey) return false;
  const r = db.prepare('SELECT consent_at FROM customers WHERE line_user_id=?').get(customerKey);
  return !!(r && r.consent_at);
}
/** Erase one customer's personal data. Returns what was touched so the owner sees it happened. */
export function forgetCustomer(customerKey) {
  const key = String(customerKey || '').trim();
  if (!key) throw new Error('customer_required');
  const cust = db.prepare('SELECT * FROM customers WHERE line_user_id=?').get(key);
  const touched = { orders: 0, tickets: 0, coupons: 0, loyaltyMoves: 0, pushLog: 0, customer: 0 };
  // Count the sales BEFORE cutting the link, so the confirmation can honestly say what survived.
  touched.orders = db.prepare(
    'SELECT COUNT(*) n FROM orders o JOIN tickets t ON t.id=o.ticket_id WHERE t.line_user_id=? OR t.customer_key=?'
  ).get(key, key).n;
  db.transaction(() => {
    // The identity lives on the TICKET (orders carry only money). Keep the ticket and its order —
    // they are the accounting record — but strip every trace of who it was.
    touched.tickets = db.prepare("UPDATE tickets SET line_user_id=NULL, customer_key=NULL, customer_name='(ลบข้อมูลแล้ว)' WHERE line_user_id=? OR customer_key=?").run(key, key).changes;
    // Anything that only exists to identify or reward the person goes entirely.
    touched.coupons = db.prepare('DELETE FROM customer_coupons WHERE customer_key=?').run(key).changes;
    touched.loyaltyMoves = db.prepare('DELETE FROM loyalty_moves WHERE customer_key=?').run(key).changes;
    try { db.prepare('UPDATE coupon_uses SET customer_key=NULL WHERE customer_key=?').run(key); } catch { /* older DB */ }
    try { touched.pushLog = db.prepare('DELETE FROM push_log WHERE user_id=?').run(key).changes; } catch { /* older DB */ }
    try { db.prepare('UPDATE customers SET referred_by=NULL WHERE referred_by=?').run(key); } catch { /* older DB */ }
    touched.customer = db.prepare('DELETE FROM customers WHERE line_user_id=?').run(key).changes;
  })();
  return { ok: true, name: cust ? cust.name : null, touched };
}

// ---------- Online ordering: manual kill switch + offline auto-pause ----------
// The customer's LIFF talks to this server from THEIR phone, over THEIR data. When the shop's
// own internet dies, orders keep arriving that nobody at the counter can see — and the cashier
// cannot press "close" either, because their device has no connection. Two controls:
//   1. onlineOrders  — an explicit switch: stop taking LINE orders, keep selling at the counter.
//   2. posOfflineMinutes — a dead-man's switch: if no cashier device has checked in for N minutes
//      the server pauses LINE ordering BY ITSELF, and resumes the moment a till reappears.
// 0 minutes = the dead-man's switch is off (default, so nothing changes until the owner opts in).
export function onlineOrdersEnabled() { return getSetting('online_orders', '1') !== '0'; }
export function setOnlineOrders(on) { setSetting('online_orders', on ? '1' : '0'); return { onlineOrders: !!on }; }
export function getPosOfflineMinutes() { return Math.max(0, parseInt(getSetting('pos_offline_minutes', '0'), 10) || 0); }
export function setPosOfflineMinutes(n) {
  const v = Math.max(0, Math.min(180, parseInt(n, 10) || 0));
  setSetting('pos_offline_minutes', String(v));
  return { posOfflineMinutes: v };
}
/** A till checked in. Called on cashier login and on a light periodic ping. */
export function cashierHeartbeat() {
  setSetting('pos_last_seen', db.prepare("SELECT datetime('now') t").get().t);
  return { ok: true };
}
export function posLastSeen() { return getSetting('pos_last_seen', null); }
/** Has every till gone quiet for longer than the configured window? */
export function posOffline() {
  const mins = getPosOfflineMinutes();
  if (!mins) return false;
  const last = posLastSeen();
  if (!last) return false;              // never seen a till → don't block sales on a fresh install
  return db.prepare(`SELECT (? < datetime('now','-${mins} minutes')) AS stale`).get(last).stale === 1;
}
/** Why (if at all) customer ordering is closed right now. One place, used by the API and the gate. */
export function orderingPaused() {
  if (!onlineOrdersEnabled()) return { paused: true, code: 'online_orders_off', reason: 'ร้านปิดรับออเดอร์ออนไลน์ชั่วคราว' };
  if (posOffline()) return { paused: true, code: 'pos_offline', reason: 'ร้านออฟไลน์อยู่ — สั่งที่หน้าร้านได้ตามปกติ' };
  return { paused: false, code: null, reason: null };
}
// PDPA notice bar on the LIFF: owner-switchable, default OFF (the owner wants it hidden until
// they choose to show it). Consent already recorded stays recorded either way.
export function pdpaNoticeEnabled() { return getSetting('pdpa:notice', '0') === '1'; }
export function setPdpaNotice(on) { setSetting('pdpa:notice', on ? '1' : '0'); return { pdpaNotice: !!on }; }
export function socialProofEnabled() { return getSetting('social:enabled', '0') === '1'; }
export function setSocialProof(on) { setSetting('social:enabled', on ? '1' : '0'); return { social: !!on }; }
// Count of drinks (base items) sold today across paid, non-void orders (Bangkok day).
export function soldTodayCount() {
  const r = db.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) c
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.payment_status = 'paid' AND oi.kind = 'base'
       AND date(o.paid_at, '+7 hours') = date('now','+7 hours')`
  ).get();
  return r ? (r.c || 0) : 0;
}
// Mascot greeting (owner-toggleable, default OFF): a friendly bouncing logo + greeting on the home.
export function mascotEnabled() { return getSetting('mascot:enabled', '0') === '1'; }
export function setMascot(on) { setSetting('mascot:enabled', on ? '1' : '0'); return { mascot: !!on }; }
// Auto-void abandoned (unpaid) pending orders after N minutes so they don't pile up on the
// till. Default 30 min; 0 disables. Owner-configurable in ⚙ จัดการ.
export function getPendingVoidMinutes() { return Math.max(0, Math.floor(Number(getSetting('pending:void_min', '30')) || 0)); }
export function setPendingVoidMinutes(m) { const n = Math.max(0, Math.floor(Number(m) || 0)); setSetting('pending:void_min', String(n)); return { pendingVoidMinutes: n }; }
/** Queue-first model: when ON, an order gets its queue number the moment it's placed (cashier or
 *  LINE), so it joins the line immediately even before payment. OFF = pay-first (number at payment).
 *  Payment is still required before an order can be SERVED in either mode. */
export function getQueueFirst() { return getSetting('queue:first', '0') === '1'; }
export function setQueueFirst(on) { setSetting('queue:first', on ? '1' : '0'); return { queueFirst: !!on }; }

/** Cashier commits to making a queued order → locks the customer's self-cancel (idempotent). */
export function startMaking(ticketId, { actorId = null } = {}) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (!t.making_at) db.prepare("UPDATE tickets SET making_at=datetime('now'), cancel_requested=NULL WHERE id=?").run(ticketId);
  return db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
}
/** A LINE customer asks to cancel their own order. Allowed only while it's unpaid, NOT being made,
 *  and still open — otherwise rejected. Does NOT void; raises a sticky request for the cashier. */
export function customerRequestCancel(ticketId, lineUserId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (!lineUserId || t.line_user_id !== lineUserId) throw new Error('not_your_order');
  if (!['pending', 'waiting'].includes(t.status)) throw new Error('too_late');
  if (t.making_at) throw new Error('already_making');
  const o = db.prepare('SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (o && o.payment_status === 'paid') throw new Error('already_paid');
  db.prepare("UPDATE tickets SET cancel_requested=datetime('now') WHERE id=?").run(ticketId);
  return { ok: true };
}
/** Cashier keeps the order despite the customer's cancel request (clears the sticky flag). */
export function dismissCancelRequest(ticketId) {
  db.prepare('UPDATE tickets SET cancel_requested=NULL WHERE id=?').run(ticketId);
  return { ok: true };
}
/** Cashier nudges the LINE customer to pay before the kitchen makes it (queue-first waste guard). */
export function askToPay(ticketId) {
  const t = db.prepare('SELECT line_user_id, code, zone_id FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (!t.line_user_id) return { ok: false, reason: 'no_line' };
  const o = db.prepare('SELECT total, discount FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  const amt = o ? (o.total - (o.discount || 0)) : 0;
  pushQueue(t.line_user_id, `🙏 รบกวนชำระเงินก่อนนะคะ ยอด ฿${amt}\nคิว ${t.code} — ชำระแล้วทางร้านจะเริ่มทำเครื่องดื่มให้เลยค่ะ`, queueLink(t.zone_id), 'ชำระเงิน');
  return { ok: true };
}
// Store opening hours → auto-close. Empty open/close = always open (no behaviour change).
// Store hours now live per-branch on the stores row (hours_open/hours_close/hours_days, enforced by
// isStoreOpenRow at order time). The old settings-based hours:* layer was display-only and is gone.
// Owner LINE notifications: DORMANT until the owner stores their LINE userId. notifyOwner()
// no-ops when unset or when the LINE channel is off — so this is safe to ship disabled.
export function getOwnerLineId() { return (getSetting('owner:line_id', '') || '').trim(); }
// A LINE userId is ALWAYS 'U' + 32 hex chars. The owner had typed "Keys7" — the summary then
// silently failed forever because the destination was garbage. Reject anything that isn't a real
// id (empty is allowed = "clear it"), so the mistake is caught at the moment of saving.
const LINE_UID_RE = /^U[0-9a-f]{32}$/i;
export function validOwnerLineId(id) { return LINE_UID_RE.test(String(id || '').trim()); }
export function setOwnerLineId(id) {
  const v = (id || '').toString().trim().slice(0, 80);
  if (v && !validOwnerLineId(v)) throw new Error('owner_id_invalid');
  setSetting('owner:line_id', v);
  return { ownerLineId: getOwnerLineId() };
}
// Push to the owner and report what we can know synchronously — the old version returned sent:true
// whenever an id existed, so "Keys7" read as success. reason: no_id | invalid_id | line_off | sent.
// The push itself is fire-and-forget (its own success/failure is recorded in push_log); the point
// here is to catch the common, knowable failures — no id, or an id that could never work.
// AWAIT the push and report what LINE actually did. This used to fire-and-forget pushText() and
// return sent:true unconditionally — so a rejected push (owner never added the OA as a friend, they
// blocked it, the channel token expired, the monthly quota ran out) was reported as a success. Worse,
// maybeAutoSummary() marks the day done on sent:true, so one silent rejection meant that day's
// summary was never retried. The shop saw "✅ ส่งแล้ว" and no message ever arrived.
export async function notifyOwner(text, kind = 'owner', summaryData = null) {
  const id = getOwnerLineId();
  if (!id) return { sent: false, reason: 'no_id' };
  if (!validOwnerLineId(id)) return { sent: false, reason: 'invalid_id' };
  if (!text) return { sent: false, reason: 'no_text' };
  if (!LINE_ENABLED) return { sent: false, reason: 'line_off' };
  // A card when we have numbers worth laying out; plain text otherwise (stock alert, PO draft).
  const ok = summaryData ? await pushSummary(id, summaryData, text, kind) : await pushText(id, text, kind);
  // Remember WHY it failed so the ⚙ panel can name the cause instead of saying "ล้มเหลว".
  try {
    const e = ok ? null : lastPushError();
    setSetting('owner:last_push_error', e ? JSON.stringify(e) : '');
  } catch { /* never block on diagnostics */ }
  return { sent: !!ok, reason: ok ? 'sent' : 'push_failed', error: ok ? null : lastPushError() };
}
/** Ask LINE two questions the owner cannot answer from the outside:
 *  1) which OA does the token on THIS server belong to (real @138dccus vs a test OA)?
 *  2) is the saved owner id a user of that same OA, and a friend?
 *  A userId is per-channel, so an id captured from a different OA's webhook fails forever even
 *  though "add friend" was done and the id looks valid — this is the check that shows it. */
export async function lineCheck() {
  const id = getOwnerLineId();
  const bot = await botInfo();
  const friend = id ? await friendCheck(id) : { ok: false, reason: 'no_id' };
  // Webhook: the "พิมพ์ id แล้วระบบตอบรหัสให้" trick — and every queue reply — depends on it.
  // With it off or pointed elsewhere, the customer's message never reaches this server at all.
  const wh = await webhookInfo();
  const want = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/line/webhook';
  const whTest = (wh.ok && wh.endpoint && wh.active) ? await webhookTest() : null;
  const webhook = { ...wh, expected: want, matches: !!(wh.ok && wh.endpoint === want), test: whTest };
  let webhookVerdict = null;
  if (wh.ok && !wh.endpoint) webhookVerdict = `ยังไม่ได้ตั้ง Webhook — พิมพ์ "id" ในแชทจะไม่มีอะไรตอบกลับ · กดปุ่ม "ตั้ง Webhook ให้อัตโนมัติ" ด้านล่างได้เลย`;
  else if (wh.ok && !wh.active) webhookVerdict = 'Webhook ตั้งไว้แล้วแต่ยัง "ปิดใช้งาน" — เปิดที่ LINE Official Account Manager → ตั้งค่า → การตอบกลับ → เปิด Webhook (และปิดโหมดแชทอัตโนมัติ)';
  else if (wh.ok && !webhook.matches) webhookVerdict = `Webhook ชี้ไปที่อื่น (${wh.endpoint}) ไม่ใช่เซิร์ฟเวอร์นี้ — ควรเป็น ${want}`;
  else if (whTest && whTest.ok && !whTest.success) webhookVerdict = `LINE ยิงทดสอบไปที่ Webhook แล้วไม่สำเร็จ (${whTest.statusCode || whTest.reason || 'ไม่ทราบสาเหตุ'})`;
  let verdict = null;
  if (!LINE_ENABLED) verdict = 'ระบบ LINE ปิดอยู่บนเซิร์ฟเวอร์นี้ (ไม่ได้ตั้ง token) — ส่งจริงไม่ได้';
  else if (!bot.ok) verdict = 'Token ของ LINE ใช้ไม่ได้ — ต้องออก Channel access token ใหม่ใน LINE Developers';
  else if (!id) verdict = 'ยังไม่ได้ตั้ง LINE userId ของเจ้าของ';
  else if (friend.ok && friend.friend) verdict = 'พร้อมส่ง — id นี้เป็นเพื่อนกับ OA ที่ระบบใช้อยู่';
  else if (friend.ok && !friend.friend)
    verdict = `LINE ไม่รู้จัก id นี้ในบัญชี ${bot.basicId || 'OA ที่ระบบใช้อยู่'} — แปลว่ารหัส U… ถูกคัดลอกมาจาก OA อื่น (เช่นตัวทดสอบ) `
      + `หรือยังไม่ได้ทักแชทกับ OA นี้ · วิธีแก้: ทักแชท ${bot.basicId || 'OA ของร้าน'} แล้วพิมพ์ "id" เพื่อรับรหัสของ OA นี้โดยตรง`;
  return { lineOn: LINE_ENABLED, bot, ownerId: id || null, friend, verdict, webhook, webhookVerdict };
}
/** Owner-triggered: point the OA's webhook at this server (so "id" in the chat can reply). */
export async function pointWebhookHere() {
  const url = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/line/webhook';
  if (!/^https:\/\//.test(url)) return { ok: false, reason: 'no_public_url' };
  const r = await setWebhook(url);
  return { ...r, endpoint: url };
}
/** Turn a raw LINE failure into the single sentence that tells the owner what to DO. */
export function pushErrorHint(err) {
  if (!err) return null;
  const s = Number(err.status) || 0, d = String(err.detail || '');
  if (/not.*friend|blocked|ไม่ได้เป็นเพื่อน/i.test(d) || s === 403)
    return 'บัญชี LINE นี้ยังไม่ได้เพิ่มร้านเป็นเพื่อน (หรือบล็อกไว้) — เพิ่มเพื่อนแล้วลองใหม่';
  if (s === 400) return 'LINE ไม่รู้จัก userId นี้ในบัญชี OA ของร้าน — รหัส U… ต้องได้มาจากการทักแชทกับ OA ร้านนี้เท่านั้น (รหัสจาก OA อื่น/ระบบทดสอบใช้ไม่ได้)';
  if (s === 401 || s === 403) return 'Token ของ LINE OA หมดอายุหรือไม่ถูกต้อง — ต้องออก Channel access token ใหม่';
  if (s === 429) return 'ส่งเกินโควตาข้อความของ LINE OA เดือนนี้';
  return null;
}
/** Compose a short Thai end-of-day summary. dateStr (YYYY-MM-DD) = summarize THAT Bangkok day —
 *  used by the midnight fallback, which reports on yesterday. Default = today. */
export function composeDailySummary(branchId = null, dateStr = null) {
  const validDay = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const day = validDay ? dateStr : db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const r = dailyReport(branchId, validDay ? dateStr : null); const v = r.voided || {};
  // Thai-formatted Bangkok date (e.g. "พฤ 24 ก.ค. 2569") so a saved/forwarded summary is always
  // anchored to the day it covers — the owner reads these later, not only at close time.
  const bk = db.prepare("SELECT strftime('%d',?) d, strftime('%m',?) m, strftime('%Y',?) y, strftime('%w',?) w").get(day, day, day, day);
  const THMON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const THDOW = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  const dateTh = `${THDOW[Number(bk.w)]} ${Number(bk.d)} ${THMON[Number(bk.m) - 1]} ${Number(bk.y) + 543}`;
  const lines = [
    `📊 สรุปยอด${validDay ? '' : 'วันนี้'} — ${process.env.BRAND_NAME || 'YO-DEE Yogurt'}`,
    `🗓️ ${dateTh}`,
    `💰 ยอดขาย ฿${r.revenue} (${r.cupsSold || 0} ${UNIT})`,
    `📈 กำไรสุทธิ ฿${Math.round(r.pnl?.netProfit || 0)}`,
    `❌ ยกเลิก ${v.cancelled?.orders || 0} · 💸 คืนเงิน ${v.refunded?.orders || 0} · 🗑️ ของเสีย ${v.waste?.cups || 0} ${UNIT}`,
  ];
  if (r.avgRating != null) lines.push(`⭐ รีวิวเฉลี่ย ${r.avgRating} (${r.ratingCount} รีวิว)`);
  // Anti-fraud: surface today's revenue-reductions (who reduced revenue) in the owner's daily push.
  // listReductions is today-only — skipped when summarizing a past day (midnight fallback).
  try {
    if (validDay) throw new Error('skip');
    const red = listReductions(branchId || 1);
    if (red.total > 0 || (red.redeems && red.redeems.length)) {
      lines.push(`🛡️ ลดยอดรวม ฿${red.total} (ยกเลิก ฿${red.byType.void} · ของเสีย ฿${red.byType.waste} · ลดราคา ฿${red.byType.discount})`);
      if (red.byStaff && red.byStaff.length) lines.push('👤 ' + red.byStaff.map((s) => `${s.staff} ฿${s.amount}`).join(' · '));
      if (red.redeems && red.redeems.length) lines.push(`🎁 แลกของรางวัล/วันเกิด ${red.redeems.length} รายการ`);
    }
  } catch { /* additive — never break the summary */ }
  // Cash drawer over/short of the day's last closed round.
  try {
    const last = db.prepare("SELECT over_short FROM cash_sessions WHERE branch_id=? AND closed_at IS NOT NULL AND date(closed_at,'+7 hours')=? ORDER BY id DESC LIMIT 1").get(branchId || 1, day);
    if (last) lines.push(last.over_short === 0 ? '💵 เงินสด: พอดี ✓' : `💵 เงินสด${last.over_short > 0 ? 'เกิน' : 'ขาด'} ฿${Math.abs(last.over_short)}`);
  } catch { /* additive */ }
  // Stock heads-up: low + near-expiry + what to reorder (uses the SCM engine).
  try {
    const low = listIngredients().filter((i) => i.low);
    if (low.length) lines.push(`⚠️ ใกล้หมด ${low.length} รายการ: ${low.slice(0, 4).map((i) => i.name).join(', ')}${low.length > 4 ? ' …' : ''}`);
    const exp = expiringLots(7);
    if (exp.length) lines.push(`⏳ ใกล้/หมดอายุ ${exp.length} ล็อต${exp.some((l) => l.expired) ? ' (มีเลยกำหนดแล้ว!)' : ''}`);
    const need = purchasePlan().filter((p) => p.suggestQty > 0);
    if (need.length) { const est = need.reduce((s, p) => s + (p.estCost || 0), 0);
      lines.push(`🛒 ควรสั่งซื้อ ${need.length} รายการ${est ? ` (~฿${Math.round(est)})` : ''}`);
      // The owner explicitly wants to see WHICH items to buy, not just a count.
      for (const p of need.slice(0, 10)) lines.push(`   • ${p.name} ×${p.suggestQty}${p.unit ? ' ' + p.unit : ''}`);
      if (need.length > 10) lines.push(`   …และอีก ${need.length - 10} รายการ`);
    }
  } catch { /* additive */ }
  return lines.join('\n');
}
/** The SAME summary as structured data, for the Flex card. The text version stays the source of
 *  truth (it is the altText and the fallback), so the card and the text can never disagree. */
export function dailySummaryData(branchId = null, dateStr = null) {
  const validDay = typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
  const day = validDay ? dateStr : db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  const r = dailyReport(branchId, validDay ? dateStr : null); const v = r.voided || {};
  const bk = db.prepare("SELECT strftime('%d',?) d, strftime('%m',?) m, strftime('%Y',?) y, strftime('%w',?) w").get(day, day, day, day);
  const THMON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const THDOW = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  const out = {
    shopName: process.env.BRAND_NAME || 'YO-DEE Yogurt',
    dateTh: `${THDOW[Number(bk.w)]} ${Number(bk.d)} ${THMON[Number(bk.m) - 1]} ${Number(bk.y) + 543}`,
    unit: UNIT,
    revenue: r.revenue, cups: r.cupsSold || 0,
    netProfit: Math.round(r.pnl?.netProfit || 0),
    cancelled: v.cancelled?.orders || 0, refunded: v.refunded?.orders || 0, wasteCups: v.waste?.cups || 0,
    rating: r.avgRating, ratingCount: r.ratingCount || 0,
    cashLine: null, lowCount: 0, expiringCount: 0, expired: false,
    buyCount: 0, buyCost: 0, buyList: [],
    // Deep links, not just "open the app": ?go= lands on the exact page after the PIN screen, so
    // the owner standing in Makro taps once and sees the draft order instead of hunting menus.
    link: process.env.PUBLIC_BASE_URL ? (process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/cashier/?go=report') : null,
    poLink: process.env.PUBLIC_BASE_URL ? (process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/cashier/?go=po') : null,
  };
  try {
    const last = db.prepare("SELECT over_short FROM cash_sessions WHERE branch_id=? AND closed_at IS NOT NULL AND date(closed_at,'+7 hours')=? ORDER BY id DESC LIMIT 1").get(branchId || 1, day);
    if (last) out.cashLine = last.over_short === 0
      ? { ok: true, text: 'พอดี ✓' }
      : { ok: false, text: `${last.over_short > 0 ? 'เกิน' : 'ขาด'} ฿${Math.abs(last.over_short)}` };
  } catch { /* additive */ }
  try {
    out.lowCount = listIngredients().filter((i) => i.low).length;
    const exp = expiringLots(7);
    out.expiringCount = exp.length; out.expired = exp.some((l) => l.expired);
    const need = purchasePlan().filter((p) => p.suggestQty > 0);
    out.buyCount = need.length;
    out.buyCost = Math.round(need.reduce((s, p) => s + (p.estCost || 0), 0));
    out.buyList = need.map((p) => `${p.name} ×${p.suggestQty}${p.unit ? ' ' + p.unit : ''}`);
  } catch { /* additive */ }
  return out;
}
export function autoSummaryEnabled() { return getSetting('summary:auto', '0') === '1'; }
export function setAutoSummary(on) { setSetting('summary:auto', on ? '1' : '0'); return { autoSummary: !!on }; }
/** Fire the owner summary at most once per Bangkok day (dedup key), when auto-summary is on.
 *  Called when the cash drawer is closed (the natural end-of-day moment). */
export async function maybeAutoSummary(branchId = null, dateStr = null) {
  if (!autoSummaryEnabled()) return { sent: false, reason: 'off' };
  const day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    ? dateStr : db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  if (getSetting('summary:last_sent', '') === day) return { sent: false, reason: 'already' };
  const r = await pushOwnerSummary(branchId, dateStr);
  // Only mark the day done once it actually went out. If the owner has no id / a bad id, the next
  // close will try again — so fixing "Keys7" makes the very next round's summary arrive.
  if (r.sent) setSetting('summary:last_sent', day);
  return r;
}
/** The win-back composer's last setup (message + which coupon is attached). The owner sets this up
 *  once and expects it to still be there next time — it used to reset on every page open, so the
 *  attached coupon silently vanished and blasts went out with no gift. Stored server-side so it
 *  survives a different till/device too. */
export function campaignDefaults() {
  return {
    message: getSetting('crm:msg', '') || null,
    couponOn: getSetting('crm:coupon_on', '0') === '1',
    couponId: Number(getSetting('crm:coupon_id', '0')) || null,
  };
}
export function setCampaignDefaults({ message, couponOn, couponId } = {}) {
  if (message != null) setSetting('crm:msg', String(message).slice(0, 380));
  if (couponOn != null) setSetting('crm:coupon_on', couponOn ? '1' : '0');
  if (couponId !== undefined) setSetting('crm:coupon_id', couponId ? String(Number(couponId) || 0) : '');
  return campaignDefaults();
}
/** Cashier-safe availability flip: ONLY the active flag, never price/name/recipe. The till needs
 *  to pull a sold-out drink off the menu immediately; editing what a drink COSTS stays manager+. */
export function setMenuAvailable(id, on) {
  const it = db.prepare('SELECT id, name, active FROM menu_items WHERE id=?').get(Number(id));
  if (!it) throw new Error('item_not_found');
  db.prepare('UPDATE menu_items SET active=? WHERE id=?').run(on ? 1 : 0, it.id);
  return { id: it.id, name: it.name, active: on ? 1 : 0 };
}
// ---------- No-show strikes (default OFF): ลูกค้าที่กดคิว/สั่งแล้วไม่มารับซ้ำๆ ----------
// Strikes are DERIVED from tickets (status='no_show') inside a sliding window — nothing to keep in
// sync. Blocking applies ONLY to LINE self-service (queue + self-order); the counter always sells.
// A cashier can forgive: customers.noshow_forgiven_at restarts the count from that moment, and old
// strikes also age out of the window by themselves.
export function noshowEnabled() { return getSetting('noshow:on', '0') === '1'; }
export function setNoshowEnabled(on) { setSetting('noshow:on', on ? '1' : '0'); return { noshowOn: !!on }; }
export function getNoshowRules() {
  const limit = Math.max(1, Math.min(10, parseInt(getSetting('noshow:limit', '3')) || 3));
  // Two tiers, owner's rule: reaching `limit` costs the pay-later privilege (they can still order
  // online, but must pay first — the shop carries no risk). No-showing AGAIN after that closes the
  // online channel entirely. Default = one more strike than the prepay threshold.
  const blockLimit = Math.max(limit + 1, Math.min(20, parseInt(getSetting('noshow:block_limit', String(limit + 1))) || (limit + 1)));
  return {
    limit, blockLimit,
    windowDays: Math.max(1, Math.min(365, parseInt(getSetting('noshow:window_days', '30')) || 30)),
  };
}
export function setNoshowRules({ limit, blockLimit, windowDays } = {}) {
  if (limit != null) setSetting('noshow:limit', String(Math.max(1, Math.min(10, parseInt(limit) || 3))));
  if (blockLimit != null) setSetting('noshow:block_limit', String(Math.max(1, Math.min(20, parseInt(blockLimit) || 4))));
  if (windowDays != null) setSetting('noshow:window_days', String(Math.max(1, Math.min(365, parseInt(windowDays) || 30))));
  return { noshowOn: noshowEnabled(), ...getNoshowRules() };
}
/** Live strike count + verdict for one LINE customer: normal → prepay → blocked. */
export function noshowStrikes(lineUserId) {
  const { limit, blockLimit, windowDays } = getNoshowRules();
  if (!lineUserId) return { strikes: 0, limit, blockLimit, windowDays, prepay: false, blocked: false };
  const forgiven = db.prepare('SELECT noshow_forgiven_at f FROM customers WHERE line_user_id=?').get(lineUserId)?.f || '1970-01-01';
  const n = db.prepare(
    `SELECT COUNT(*) n FROM tickets
      WHERE line_user_id=? AND status='no_show'
        AND COALESCE(closed_at, created_at) > ?
        AND COALESCE(closed_at, created_at) >= datetime('now', ?)`
  ).get(lineUserId, forgiven, `-${windowDays} days`).n;
  const on = noshowEnabled();
  return { strikes: n, limit, blockLimit, windowDays,
    prepay: on && n >= limit && n < blockLimit,
    blocked: on && n >= blockLimit };
}
/** Cashier forgives the customer — the count restarts from now (no history is deleted). */
export function forgiveNoshow(lineUserId) {
  if (!lineUserId) throw new Error('no_customer');
  db.prepare(`INSERT OR IGNORE INTO customers (line_user_id, name) VALUES (?, NULL)`).run(lineUserId);
  db.prepare(`UPDATE customers SET noshow_forgiven_at=datetime('now') WHERE line_user_id=?`).run(lineUserId);
  return noshowStrikes(lineUserId);
}
// ---------- แคมเปญเลขนำโชค (default OFF) ----------
// Whoever draws the lucky queue number that day wins a drink on the house. EVERY zone that reaches
// the number produces a winner (owner's choice), so a 3-zone day can have 3 winners.
// LINE customers only: the prize is shown and claimed inside the customer's own ticket screen, and a
// walk-in has no screen to show it on.
// It also REQUIRES queue-first. With pay-first the number is only issued after payment, so there is
// no unpaid order left to discount — the campaign would win and have nothing to apply to.
export function luckyEnabled() { return getSetting('lucky:on', '0') === '1'; }
export function setLucky(on) { setSetting('lucky:on', on ? '1' : '0'); return { luckyOn: !!on }; }
export function getLuckyNumber() { return Math.max(1, Math.round(Number(getSetting('lucky:number', '67')) || 67)); }
export function setLuckyNumber(n) {
  const v = Math.max(1, Math.min(9999, Math.round(Number(n) || 67)));
  setSetting('lucky:number', String(v)); return { luckyNumber: v };
}
// Bound coupon (owner rule: define coupons in one place). When set, the prize value follows the
// coupon; the hand-typed lucky:value is the fallback if it is later deleted or switched off.
function luckyCoupon() {
  const cid = Math.round(Number(getSetting('lucky:coupon_id', '')) || 0) || null;
  return cid ? db.prepare('SELECT * FROM coupons WHERE id=? AND active=1').get(cid) : null;
}
export function setLuckyCoupon(couponId) {
  if (couponId === null || couponId === '' || Number(couponId) === 0) { setSetting('lucky:coupon_id', ''); return luckyStatus(); }
  if (!db.prepare('SELECT id FROM coupons WHERE id=? AND active=1').get(Number(couponId))) throw new Error('coupon_not_found');
  setSetting('lucky:coupon_id', String(Math.round(Number(couponId))));
  return luckyStatus();
}
export function getLuckyValue() {
  const c = luckyCoupon();
  const fallback = Math.max(1, Number(getSetting('lucky:value', '40')) || 40);
  return c ? couponGiftValue(c, fallback) : fallback;
}
export function setLuckyValue(v) {
  const n = Math.max(1, Math.min(2000, Math.round(Number(v) || 40)));
  setSetting('lucky:value', String(n)); return { luckyValue: n };
}
/** Campaign health for the settings screen — says WHY it can't fire, instead of silently not firing. */
export function luckyStatus() {
  const on = luckyEnabled();
  const c = luckyCoupon();
  return { on, number: getLuckyNumber(), value: getLuckyValue(), queueFirst: getQueueFirst(),
           couponId: c ? c.id : null, couponLabel: c ? c.label : null,
           ready: on && getQueueFirst(),
           reason: !on ? 'off' : (!getQueueFirst() ? 'needs_queue_first' : 'ready') };
}
/** Called right after a ticket is numbered. Marks the ticket a winner; awards nothing yet. */
function markLuckyIfWon(ticketId, number, lineUserId) {
  if (!luckyEnabled() || !lineUserId) return;
  if (Number(number) !== getLuckyNumber()) return;
  db.prepare(`UPDATE tickets SET lucky_state='won', lucky_value=?, lucky_at=datetime('now') WHERE id=? AND lucky_state IS NULL`)
    .run(getLuckyValue(), ticketId);
}
/** Customer pressed ใช้เลย. Applies the prize to THIS order (the one that won) and burns it. */
export function claimLucky(ticketId, lineUserId = null) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.lucky_state !== 'won') throw new Error(t.lucky_state ? 'lucky_already' : 'lucky_none');
  if (t.line_user_id && lineUserId && t.line_user_id !== lineUserId) throw new Error('not_owner');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') throw new Error('order_already_paid');
  if (order.payment_status === 'void') throw new Error('order_void');
  const room = Math.max(0, order.total - (order.discount || 0));
  const free = r2(Math.min(t.lucky_value || getLuckyValue(), room));
  if (free <= 0) throw new Error('nothing_to_discount');
  // Burn the prize, discount the order and record it as ONE unit. The guarded UPDATE is what stops
  // two fast taps discounting twice; the transaction is what stops a half-applied prize.
  let res;
  db.transaction(() => {
    const won = db.prepare(`UPDATE tickets SET lucky_state='used' WHERE id=? AND lucky_state='won'`).run(ticketId);
    if (!won.changes) throw new Error('lucky_already');
    res = setOrderDiscount(ticketId, { amount: (order.discount || 0) + free, reason: `🎉 เลขนำโชค ${getLuckyNumber()}`, actorId: null });
    // Mirror it into customer_coupons so ONE report covers every kind of giveaway.
    if (t.line_user_id) {
      const day = db.prepare("SELECT date('now','+7 hours') d").get().d;
      db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source, used_at, used_order_id, state, used_value)
                  VALUES (?, 'lucky', ?, ?, ?, 'lucky', datetime('now'), ?, 'redeemed', ?)`)
        .run(t.line_user_id, `เลขนำโชค ${t.code || getLuckyNumber()}`, t.lucky_value || getLuckyValue(), day, order.id, free);
    }
  })();
  return { ok: true, freeAmount: free, net: res.net };
}
/** Customer pressed ไม่รับสิทธิ — recorded, so the report can tell declines from misses. */
export function skipLucky(ticketId, lineUserId = null) {
  const t = db.prepare('SELECT line_user_id, lucky_state FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.line_user_id && lineUserId && t.line_user_id !== lineUserId) throw new Error('not_owner');
  db.prepare(`UPDATE tickets SET lucky_state='skipped' WHERE id=? AND lucky_state='won'`).run(ticketId);
  return { ok: true };
}
/** Winners in a Bangkok date range, for the owner's report. */
export function luckyReport({ from = null, to = null, days = 30 } = {}) {
  const today = db.prepare("SELECT date('now','+7 hours') d").get().d;
  let f = from, t = to;
  if (!f || !t) { const n = Math.max(1, Math.min(3650, Math.round(Number(days) || 30)));
    t = today; f = db.prepare("SELECT date('now','+7 hours','-' || ? || ' days') d").get(n - 1).d; }
  const rows = db.prepare(
    `SELECT lucky_state state, COUNT(*) n FROM tickets
      WHERE lucky_state IS NOT NULL AND date(lucky_at,'+7 hours') BETWEEN ? AND ? GROUP BY lucky_state`).all(f, t);
  const g = (s) => (rows.find((r) => r.state === s) || { n: 0 }).n;
  const value = db.prepare(
    `SELECT COALESCE(SUM(used_value),0) v FROM customer_coupons
      WHERE kind='lucky' AND used_at IS NOT NULL AND date(used_at,'+7 hours') BETWEEN ? AND ?`).get(f, t).v || 0;
  return { from: f, to: t, won: g('won') + g('used') + g('skipped'), used: g('used'), skipped: g('skipped'), pending: g('won'), value: r2(value) };
}

// ---------- Retention ----------
// Three tables grow with every order and nothing ever removed a row: push_log (one per LINE
// message), slips (a full base64 image per PromptPay order) and sale_events (the audit trail).
// On Turso that is row-size pressure plus a bigger replica pull on every sync, forever.
// Deliberately generous windows — the shop's own reports only ever look back a year, and the slip
// image is only evidence until the order is settled.
/** The loyalty LEDGER is the truth; customers.points is a cached balance that can drift (a crash
 *  between the two writes, or the old MAX(0,…) reversal clamp). Nightly self-heal: recompute every
 *  cached balance from the ledger and fix the ones that disagree. Lifetime points are left alone —
 *  the ledger's 'adjust' rows don't split earn-vs-redeem, so lifetime cannot be derived from it. */
export function reconcileLoyaltyBalances() {
  const rows = db.prepare(
    `SELECT c.line_user_id AS key, c.points,
            COALESCE((SELECT SUM(m.points) FROM loyalty_moves m WHERE m.customer_key = c.line_user_id), 0) AS bal
       FROM customers c`).all();
  let fixed = 0;
  for (const r of rows) {
    const bal = Math.max(0, Math.round(Number(r.bal) || 0));
    if (r.points !== bal) { db.prepare('UPDATE customers SET points=? WHERE line_user_id=?').run(bal, r.key); fixed++; }
  }
  return { checked: rows.length, fixed };
}

const RETAIN = { pushLogDays: 90, slipDays: 30, saleEventDays: 400 };
export function pruneOldData() {
  const out = { pushLog: 0, slips: 0, saleEvents: 0 };
  // LINE send log: the monthly cost report reads the rollup, not individual rows.
  try {
    out.pushLog = db.prepare(`DELETE FROM push_log WHERE at < datetime('now','-${RETAIN.pushLogDays} days')`).run().changes || 0;
  } catch { /* table may predate the feature */ }
  // Slip images: only for orders that are settled (paid or void) — an unresolved payment keeps its
  // evidence no matter how old, because that is exactly the case someone will need to look at.
  try {
    out.slips = db.prepare(
      `DELETE FROM slips WHERE at < datetime('now','-${RETAIN.slipDays} days')
         AND order_id IN (SELECT id FROM orders WHERE payment_status IN ('paid','void'))`).run().changes || 0;
  } catch { /* ignore */ }
  // Audit events beyond the reporting horizon (>13 months, so a full year-on-year still works).
  try {
    out.saleEvents = db.prepare(`DELETE FROM sale_events WHERE at < datetime('now','-${RETAIN.saleEventDays} days')`).run().changes || 0;
  } catch { /* ignore */ }
  return out;
}

export function autoReorderEnabled() { return getSetting('reorder:auto', '0') === '1'; }
export function setAutoReorder(on) { setSetting('reorder:auto', on ? '1' : '0'); return { autoReorder: !!on }; }
/** If anything needs reordering, draft ONE PO from the plan (once/day) and LINE the owner to
 *  review + confirm it. Never auto-RECEIVES — the owner still approves before stock/cost change. */
export async function maybeAutoReorder(branchId = null) {
  if (!autoReorderEnabled()) return { drafted: false, reason: 'off' };
  const day = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  if (getSetting('reorder:last_run', '') === day) return { drafted: false, reason: 'already' };
  setSetting('reorder:last_run', day);
  const po = draftPoFromPlan({ actorId: null });
  if (!po) return { drafted: false, reason: 'nothing' };
  const est = (po.lines || []).reduce((s, l) => s + l.lineTotal, 0);
  // List what to buy, not just a count — the owner asked to see "which items". Cap the lines so a
  // huge PO never blows past LINE's message length; the rest are a "+N more" tail.
  const items = (po.lines || []).slice(0, 12).map((l) => `• ${l.ingredient_name} ×${l.qty}${l.unit ? ' ' + l.unit : ''}`).join('\n');
  const more = (po.lines || []).length - 12;
  await notifyOwner(`🛒 ระบบร่างใบสั่งซื้อให้แล้ว: ${po.po_no}\n${po.lines.length} รายการ · ~฿${Math.round(est)}\n${items}${more > 0 ? `\n…และอีก ${more} รายการ` : ''}\n\nเปิดแอป → สต๊อก/จัดซื้อ → ใบสั่งซื้อ เพื่อตรวจ + กดรับของ`);
  return { drafted: true, poNo: po.po_no, poId: po.id, lines: po.lines.length };
}
// C: automatic win-back — customers who slipped into "at_risk" get a coupon + LINE nudge without
// the owner lifting a finger. Guard-railed: OFF by default, a MONTHLY message cap (LINE cost
// control), and a per-customer cooldown so nobody is spammed.
const WINBACK_COOLDOWN_DAYS = 45;
export function autoWinbackEnabled() { return getSetting('winback:auto', '0') === '1'; }
export function setAutoWinback(on) { setSetting('winback:auto', on ? '1' : '0'); return { autoWinback: !!on }; }
export function getAutoWinbackCap() { return Math.max(0, Math.round(Number(getSetting('winback:cap', '100')) || 0)); }
export function setAutoWinbackCap(n) { const v = Math.max(0, Math.min(5000, Math.round(Number(n) || 0))); setSetting('winback:cap', String(v)); return { autoWinbackCap: v }; }

// ---------- Bounce-back (Phase 4 #2) ----------
// A "come back soon" coupon dropped into the customer's wallet the moment they pay — to pull the hard
// SECOND visit. Default OFF (it discounts a future sale, so it's the owner's margin call). Reuses the
// exact wallet + expiry-nudge machinery as win-back, but fires on PURCHASE instead of on going quiet.
// One active at a time per customer, so a daily regular can't stack a pile of ฿10s.
export function bounceBackEnabled() { return getSetting('bounceback:enabled', '0') === '1'; }
export function getBounceBackConfig() {
  return {
    enabled: bounceBackEnabled(),
    amount: Math.max(1, Math.round(Number(getSetting('bounceback:amount', '10')) || 10)),
    days: Math.max(1, Math.min(60, Math.round(Number(getSetting('bounceback:days', '3')) || 3))),
  };
}
export function setBounceBackConfig(patch = {}) {
  if (patch.enabled != null) setSetting('bounceback:enabled', patch.enabled ? '1' : '0');
  if (patch.amount != null) setSetting('bounceback:amount', String(Math.max(1, Math.min(1000, Math.round(Number(patch.amount) || 10)))));
  if (patch.days != null) setSetting('bounceback:days', String(Math.max(1, Math.min(60, Math.round(Number(patch.days) || 3)))));
  return getBounceBackConfig();
}
// Best-effort — NEVER throws (must not break a sale). Skips if the customer already holds an active
// bounce-back, so back-to-back purchases don't stack coupons.
function issueBounceBack(customerKey) {
  try {
    if (!customerKey || !bounceBackEnabled()) return { issued: false };
    if (customerCoupons(customerKey).some((c) => c.kind === 'bounceback')) return { issued: false, reason: 'already_active' };
    const cfg = getBounceBackConfig();
    const expiresAt = db.prepare(`SELECT date(datetime('now','+7 hours'),'+' || ? || ' days') d`).get(cfg.days).d;
    const label = `กลับมาใน ${cfg.days} วัน ลด ฿${cfg.amount}`;
    db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'bounceback', ?, ?, ?, 'bounceback')`)
      .run(customerKey, label, cfg.amount, expiresAt);
    return { issued: true, label, expiresAt };
  } catch { return { issued: false, reason: 'error' }; }
}
// ---------- Daily streak (Phase 4 #3) ----------
// Rewards consecutive-day visits: order on N Bangkok-days in a row → a bonus coupon drops into the
// wallet, then the streak resets so it can be earned again. Default OFF (it's the owner's margin
// call). Reuses the same wallet/redeem machinery as bounce-back — a "up to ฿X off" value coupon.
export function streakEnabled() { return getSetting('streak:enabled', '0') === '1'; }
export function getStreakConfig() {
  return {
    enabled: streakEnabled(),
    days: Math.max(2, Math.min(30, Math.round(Number(getSetting('streak:days', '3')) || 3))),
    amount: Math.max(1, Math.round(Number(getSetting('streak:amount', '15')) || 15)),
  };
}
export function setStreakConfig(patch = {}) {
  if (patch.enabled != null) setSetting('streak:enabled', patch.enabled ? '1' : '0');
  if (patch.days != null) setSetting('streak:days', String(Math.max(2, Math.min(30, Math.round(Number(patch.days) || 3)))));
  if (patch.amount != null) setSetting('streak:amount', String(Math.max(1, Math.min(1000, Math.round(Number(patch.amount) || 15)))));
  return getStreakConfig();
}
// Advance the customer's daily-visit streak on a paid order; award + reset when it reaches the
// target. Idempotent per Bangkok-day (a 2nd order same day doesn't advance it). Never throws.
function bumpStreak(customerKey) {
  try {
    if (!customerKey || !streakEnabled()) return { issued: false };
    const days = db.prepare(`SELECT date(datetime('now','+7 hours')) t, date(datetime('now','+7 hours'),'-1 day') y`).get();
    const row = db.prepare(`SELECT streak_count AS n, streak_last_day AS last FROM customers WHERE line_user_id=?`).get(customerKey);
    const last = row ? row.last : null;
    if (last === days.t) return { issued: false, reason: 'counted_today' };   // already advanced today
    let n = (last === days.y) ? ((row && row.n) || 0) + 1 : 1;                // continue or restart
    const cfg = getStreakConfig();
    let out = { issued: false, count: n, target: cfg.days };
    if (n >= cfg.days && !customerCoupons(customerKey).some((c) => c.kind === 'streak')) {
      const expiresAt = db.prepare(`SELECT date(datetime('now','+7 hours'),'+30 days') d`).get().d;
      const label = `มาต่อเนื่อง ${cfg.days} วัน ลด ฿${cfg.amount}`;
      db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'streak', ?, ?, ?, 'streak')`)
        .run(customerKey, label, cfg.amount, expiresAt);
      out = { issued: true, label, expiresAt, count: n, target: cfg.days };
      n = 0;   // reset — the streak is earned again after another run of N days
    }
    db.prepare(`INSERT INTO customers (line_user_id, streak_count, streak_last_day) VALUES (?,?,?)
                 ON CONFLICT(line_user_id) DO UPDATE SET streak_count=excluded.streak_count, streak_last_day=excluded.streak_last_day`)
      .run(customerKey, n, days.t);
    return out;
  } catch { return { issued: false, reason: 'error' }; }
}
// ---------- Flash sale / happy hour (Phase 4 #4) ----------
// A time-boxed "⚡ ลดทุกออเดอร์" window the owner opens for a slow part of the day. While the window
// is live a customer claims ONE flash coupon into their wallet (a "up to ฿X off" value coupon on the
// same machinery as bounce-back). Default OFF; it touches NO menu price, so accounting/VAT/COGS are
// completely untouched — it's a coupon, not a repricing.
export function flashSaleActive() {
  if (getSetting('flash:enabled', '0') !== '1') return false;
  const h = db.prepare(`SELECT CAST(strftime('%H', datetime('now','+7 hours')) AS INT) h`).get().h;
  const start = Math.max(0, Math.min(23, Math.round(Number(getSetting('flash:start', '17')) || 0)));
  let end = Math.max(1, Math.min(24, Math.round(Number(getSetting('flash:end', '19')) || 0)));
  if (end <= start) end = Math.min(24, start + 1);
  return h >= start && h < end;
}
export function getFlashSaleConfig() {
  const start = Math.max(0, Math.min(23, Math.round(Number(getSetting('flash:start', '17')) || 0)));
  let end = Math.max(1, Math.min(24, Math.round(Number(getSetting('flash:end', '19')) || 0)));
  if (end <= start) end = Math.min(24, start + 1);
  return {
    enabled: getSetting('flash:enabled', '0') === '1',
    start, end,
    amount: Math.max(1, Math.round(Number(getSetting('flash:amount', '20')) || 20)),
    active: flashSaleActive(),
  };
}
export function setFlashSaleConfig(patch = {}) {
  if (patch.enabled != null) setSetting('flash:enabled', patch.enabled ? '1' : '0');
  if (patch.start != null) setSetting('flash:start', String(Math.max(0, Math.min(23, Math.round(Number(patch.start) || 0)))));
  if (patch.end != null) setSetting('flash:end', String(Math.max(1, Math.min(24, Math.round(Number(patch.end) || 1)))));
  if (patch.amount != null) setSetting('flash:amount', String(Math.max(1, Math.min(1000, Math.round(Number(patch.amount) || 20)))));
  return getFlashSaleConfig();
}
// Drop today's flash coupon into the customer's wallet. Idempotent per Bangkok-day (one per customer
// per day). Expires end of TODAY — a flash coupon is a "use it now" nudge. Never throws.
export function claimFlashSale(customerKey) {
  try {
    if (!customerKey || !flashSaleActive()) return { issued: false, reason: 'inactive' };
    const today = db.prepare(`SELECT date(datetime('now','+7 hours')) d`).get().d;
    if (db.prepare(`SELECT 1 FROM customer_coupons WHERE customer_key=? AND kind='flash' AND date(issued_at,'+7 hours')=? LIMIT 1`).get(customerKey, today))
      return { issued: false, reason: 'already_today' };
    const cfg = getFlashSaleConfig();
    const label = `⚡ Flash Sale ลด ฿${cfg.amount} วันนี้`;
    db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'flash', ?, ?, ?, 'flash')`)
      .run(customerKey, label, cfg.amount, today);
    return { issued: true, label, expiresAt: today, amount: cfg.amount };
  } catch { return { issued: false, reason: 'error' }; }
}
// ---------- Pickup reminder ----------
// A called (พร้อมรับ) LINE order still unclaimed after N minutes gets ONE "มารับได้เลยนะคะ"
// reminder — the drink is melting and the customer may have missed the ready push. One per ticket
// ever (pickup_nudged_at), minutes settable by the owner (0 = off). Runs from the 60s sweep.
export function getPickupNudgeConfig() {
  return { minutes: Math.max(0, Math.min(120, Math.round(Number(getSetting('pickup:nudge_min', '10')) || 0))) };
}
export function setPickupNudgeConfig(patch = {}) {
  if (patch.minutes != null) setSetting('pickup:nudge_min', String(Math.max(0, Math.min(120, Math.round(Number(patch.minutes) || 0)))));
  return getPickupNudgeConfig();
}
export function nudgePickupWaiting() {
  const { minutes } = getPickupNudgeConfig();
  if (!minutes) return { nudged: 0 };
  // Today-only guard: a stale called ticket left over from a crashed day must not fire at boot.
  const rows = db.prepare(
    `SELECT id, code, zone_id, line_user_id, called_at FROM tickets
      WHERE status='called' AND line_user_id IS NOT NULL AND pickup_nudged_at IS NULL
        AND called_at IS NOT NULL AND called_at <= datetime('now', ?)
        AND date(called_at,'+7 hours') = date(datetime('now','+7 hours')) LIMIT 30`
  ).all(`-${minutes} minutes`);
  for (const r of rows) {
    db.prepare(`UPDATE tickets SET pickup_nudged_at=datetime('now') WHERE id=?`).run(r.id);
    try {
      pushQueue(r.line_user_id,
        `🔔 คิว ${r.code} ของคุณพร้อมแล้ว รอที่เคาน์เตอร์นะคะ\n` +
        `เครื่องดื่มทำเสร็จเกิน ${minutes} นาทีแล้ว รีบมารับก่อนละลายนะคะ 🍦\n` +
        `ถ้าไม่สะดวกแล้ว แจ้งยกเลิกได้จากหน้าคิวของคุณค่ะ`, queueLink(r.zone_id), 'ดูคิวของฉัน');
    } catch { /* one bad push must not stop the rest */ }
  }
  return { nudged: rows.length };
}
/** Count auto-winback coupons issued this Bangkok month (the monthly cap counts issued coupons,
 *  so it's exact even on UAT where LINE pushes are stubbed). */
function winbackIssuedThisMonth() {
  return db.prepare(
    `SELECT COUNT(*) c FROM customer_coupons WHERE kind='winback'
      AND strftime('%Y-%m', datetime(issued_at,'+7 hours')) = strftime('%Y-%m', datetime('now','+7 hours'))`
  ).get().c || 0;
}
export async function maybeAutoWinback(branchId = null) {
  if (!autoWinbackEnabled()) return { sent: 0, reason: 'off' };
  const day = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  if (getSetting('winback:last_run', '') === day) return { sent: 0, reason: 'already' };
  const cap = getAutoWinbackCap();
  const remaining = cap - winbackIssuedThisMonth();
  if (remaining <= 0) { setSetting('winback:last_run', day); return { sent: 0, reason: 'cap' }; }
  // at-risk, LINE-pushable, and not already win-backed within the cooldown window
  const cutoff = db.prepare(`SELECT datetime('now', ?) t`).get(`-${WINBACK_COOLDOWN_DAYS} days`).t;
  const targets = customersList()
    .filter((c) => c.segment === 'at_risk' && c.canPush)
    .filter((c) => !db.prepare(
      `SELECT 1 FROM customer_coupons WHERE customer_key=? AND kind='winback' AND issued_at >= ? LIMIT 1`
    ).get(c.key, cutoff))
    .slice(0, remaining)
    .map((c) => c.key);
  setSetting('winback:last_run', day);
  if (!targets.length) return { sent: 0, reason: 'none' };
  const r = await sendCampaign({
    keys: targets,
    message: 'คิดถึงลูกค้าจังเลยค่ะ 💛 ไม่ได้เจอกันนาน แวะมาทานอีกนะคะ — ทางร้านมีคูปองเล็ก ๆ ฝากไว้ให้',
    coupon: { label: 'คูปองคิดถึง — ส่วนลดต้อนรับกลับ', cap: 49, days: 30 },
    actorId: null,
  });
  return { sent: r.sent, targeted: r.targeted, reason: 'ok' };
}
export async function pushOwnerSummary(branchId = null, dateStr = null) {
  const text = composeDailySummary(branchId, dateStr);
  let data = null; try { data = dailySummaryData(branchId, dateStr); } catch { /* card optional — text still goes */ }
  const r = await notifyOwner(text, 'summary', data);
  return { ...r, text };
}
/** One glance at WHY the summary is/isn't reaching the owner — every gate in the chain. */
export function summaryDiag() {
  const id = getOwnerLineId();
  let lastPush = null;
  try { lastPush = id ? db.prepare("SELECT at, ok FROM push_log WHERE user_id=? AND kind='summary' ORDER BY id DESC LIMIT 1").get(id) || null : null; }
  catch { /* push_log may not exist */ }
  let lastError = null;
  try { const raw = getSetting('owner:last_push_error', ''); lastError = raw ? JSON.parse(raw) : null; } catch { lastError = null; }
  return {
    autoOn: autoSummaryEnabled(), hasId: !!id, idValid: id ? validOwnerLineId(id) : false,
    lineOn: LINE_ENABLED, lastSentDay: getSetting('summary:last_sent', '') || null, lastPush,
    lastError, hint: pushErrorHint(lastError),
  };
}
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
/** How a paid order earns stamps: 'cup' = 1 per drink cup (default); 'baht' = 1 per N baht spent (cashback-style). */
export function getEarnMode() { return getSetting('loyalty:earn_mode', 'cup') === 'baht' ? 'baht' : 'cup'; }
export function setEarnMode(m) { const v = m === 'baht' ? 'baht' : 'cup'; setSetting('loyalty:earn_mode', v); return { earnMode: v }; }
export function getBahtPerStar() { return Math.max(1, Math.round(Number(getSetting('loyalty:baht_per_star', '25')) || 25)); }
export function setBahtPerStar(n) { const v = Math.max(1, Math.round(Number(n) || 0)); setSetting('loyalty:baht_per_star', String(v)); return { bahtPerStar: v }; }
/** Membership tiers (Pure/Bloom/Essence) — a status layer measured by visit count (paid orders).
 *  Thresholds + perk text are owner-editable and surfaced on the LIFF member card. */
const TIER_DEFAULTS = { bloomMin: 10, essenceMin: 25,
  purePerk: 'สะสมดวง · 🎂 ของขวัญวันเกิด',
  bloomPerk: 'สิทธิ์ PURE + 🎂 โบนัสวันเกิดพิเศษ',
  essencePerk: 'สิทธิ์ทั้งหมด · ⭐ แต้มไม่หมดอายุ · 🎂 วันเกิดยาวขึ้น' };
export function getTierConfig() {
  const num = (k, d) => Math.max(0, Math.round(Number(getSetting(k, String(d))) || d));
  return {
    bloomMin: num('loyalty:tier_bloom_min', TIER_DEFAULTS.bloomMin),
    essenceMin: num('loyalty:tier_essence_min', TIER_DEFAULTS.essenceMin),
    purePerk: getSetting('loyalty:tier_pure_perk', TIER_DEFAULTS.purePerk),
    bloomPerk: getSetting('loyalty:tier_bloom_perk', TIER_DEFAULTS.bloomPerk),
    essencePerk: getSetting('loyalty:tier_essence_perk', TIER_DEFAULTS.essencePerk),
  };
}
export function setTierConfig(p = {}) {
  if (p.bloomMin != null) setSetting('loyalty:tier_bloom_min', String(Math.max(0, Math.round(Number(p.bloomMin) || 0))));
  if (p.essenceMin != null) setSetting('loyalty:tier_essence_min', String(Math.max(0, Math.round(Number(p.essenceMin) || 0))));
  if (p.purePerk != null) setSetting('loyalty:tier_pure_perk', String(p.purePerk).slice(0, 200));
  if (p.bloomPerk != null) setSetting('loyalty:tier_bloom_perk', String(p.bloomPerk).slice(0, 200));
  if (p.essencePerk != null) setSetting('loyalty:tier_essence_perk', String(p.essencePerk).slice(0, 200));
  return getTierConfig();
}
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
  // A date of birth can't be in the future, and — since the customer is entering their OWN
  // birthday to order by themselves — it can't be less than a year ago either; that's almost
  // always a mistyped year rather than a real self-ordering infant.
  const { today, cutoff } = db.prepare("SELECT date(datetime('now','+7 hours')) today, date(datetime('now','+7 hours'),'-1 year') cutoff").get();
  if (val > today) throw new Error('future_birthday');
  if (val > cutoff) throw new Error('birthday_too_recent');
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
// ---- Phone-keyed loyalty (Package 1 — no LINE) ----
// A walk-in customer is identified by phone; the loyalty key is 'tel:<digits>'. The cashier
// attaches it to the pending ticket BEFORE payment so awardPoints earns under that key.
/** Normalise a Thai phone to digits; returns null if it isn't 9–10 digits. */
export function normalizePhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return (d.length === 9 || d.length === 10) ? d : null;
}
/** Look up a phone customer's stamp balance (no side effects). */
export function loyaltyByPhone(phone) {
  const d = normalizePhone(phone);
  if (!d) throw new Error('bad_phone');
  const key = 'tel:' + d;
  const b = loyaltyBalance(key);
  return { ...b, phone: d, history: loyaltyHistory(key, 10) };
}
// ---- CRM: live customer profile (computed from real orders — no maintained aggregates, so it works
// retroactively on all history and needs no migration). A customer's orders are tickets whose
// line_user_id (LINE) OR customer_key ('tel:<phone>') matches the key. ----
/** Full profile for one customer key (LINE userId or 'tel:<digits>'). `found` is false for an
 *  unknown phone with zero history. Safe to call regardless of the loyalty-rewards toggle. */
/** A customer's own order history for the LIFF "ประวัติการสั่ง" screen: each order with its
 *  items, total, time and a human status. Keyed by their LINE id (or tel: key) — read-only. */
export function customerOrders(key, limit = 20) {
  if (!key) return [];
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  const orders = db.prepare(
    `SELECT t.id AS ticket_id, t.code, t.status AS tstatus, o.id AS order_id, o.total, o.discount,
            o.payment_status, o.void_kind, o.created_at, o.paid_at
       FROM tickets t JOIN orders o ON o.ticket_id=t.id
      WHERE (t.line_user_id=? OR t.customer_key=?)
      ORDER BY o.id DESC LIMIT ?`
  ).all(key, key, lim);
  const itemStmt = db.prepare("SELECT name, qty, price FROM order_items WHERE order_id=? AND kind='base'");
  return orders.map((o) => {
    const status = o.payment_status === 'void' ? (o.void_kind === 'refund' ? 'คืนเงินแล้ว' : 'ยกเลิกแล้ว')
      : o.payment_status === 'paid' ? (o.tstatus === 'served' ? 'รับแล้ว' : 'ชำระแล้ว')
      : 'รอชำระเงิน';
    const kind = o.payment_status === 'void' ? 'void' : (o.payment_status === 'paid' ? 'paid' : 'pending');
    return {
      ticketId: o.ticket_id, code: o.code || null, status, kind,
      at: o.paid_at || o.created_at,
      total: r2((o.total || 0) - (o.discount || 0)), discount: r2(o.discount || 0),
      items: itemStmt.all(o.order_id).map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    };
  });
}
export function customerProfile(key) {
  if (!key) return { found: false };
  const isPhone = key.startsWith('tel:');
  const cust = db.prepare('SELECT name, first_seen, birthday FROM customers WHERE line_user_id=?').get(key);
  const agg = db.prepare(
    `SELECT COUNT(DISTINCT t.id) AS visits,
            COALESCE(SUM(o.total - COALESCE(o.discount,0)),0) AS spend,
            MIN(o.paid_at) AS first_paid, MAX(o.paid_at) AS last_paid
     FROM tickets t JOIN orders o ON o.ticket_id=t.id
     WHERE (t.line_user_id=? OR t.customer_key=?) AND o.payment_status='paid'`
  ).get(key, key);
  const favourites = db.prepare(
    `SELECT oi.name, SUM(oi.qty) AS qty
     FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN tickets t ON t.id=o.ticket_id
     WHERE (t.line_user_id=? OR t.customer_key=?) AND oi.kind='base' AND o.payment_status='paid'
     GROUP BY oi.name ORDER BY qty DESC, oi.name LIMIT 3`
  ).all(key, key);
  const recent = db.prepare(
    `SELECT t.code, o.paid_at, (o.total - COALESCE(o.discount,0)) AS net
     FROM tickets t JOIN orders o ON o.ticket_id=t.id
     WHERE (t.line_user_id=? OR t.customer_key=?) AND o.payment_status='paid'
     ORDER BY o.paid_at DESC LIMIT 5`
  ).all(key, key);
  const visits = agg.visits || 0;
  const bal = loyaltyEnabled() ? loyaltyBalance(key) : null;
  return {
    found: visits > 0 || !!cust,
    key, isPhone, phone: isPhone ? key.slice(4) : null,
    name: cust?.name || null,
    firstSeen: agg.first_paid || cust?.first_seen || null,
    lastVisit: agg.last_paid || null,
    visits,
    totalSpend: Math.round((agg.spend || 0) * 100) / 100,
    favourites,
    recent,
    birthday: cust?.birthday || null,
    birthdayRedeem: birthdayRedeemStatus(key),
    loyalty: bal ? { points: bal.points, lifetime: bal.lifetime, tier: bal.tier, isBirthday: bal.isBirthday } : null,
    // Live coupons the customer holds (stamp-card conversions + birthday gifts) — shown to the
    // cashier so they can see/verify what the customer sees in the app.
    coupons: customerCoupons(key).map((c) => ({ id: c.id, kind: c.kind, label: c.label, freeCap: c.free_cap, expiresAt: c.expires_at })),
  };
}
/** Birthday free-drink redeem — once per calendar year, ledgered idempotently in loyalty_moves.
 *  Cashier-initiated (the customer card only PROMPTS; the server is the source of truth). */
export function birthdayRedeemStatus(key) {
  if (!key) return { eligible: false, used: false, available: false };
  const cust = db.prepare('SELECT birthday FROM customers WHERE line_user_id=?').get(key);
  const today = !!(cust && isBirthdayToday(cust.birthday));
  const used = !!db.prepare('SELECT 1 FROM loyalty_moves WHERE customer_key=? AND note=?').get(key, 'bday-redeem-' + bkkYear());
  return { eligible: today, used, available: today && !used };
}
export function redeemBirthday(key, actorId = null) {
  if (!key) throw new Error('no_customer');
  const cust = db.prepare('SELECT birthday FROM customers WHERE line_user_id=?').get(key);
  if (!cust || !isBirthdayToday(cust.birthday)) throw new Error('not_birthday');
  const note = 'bday-redeem-' + bkkYear();
  if (db.prepare('SELECT 1 FROM loyalty_moves WHERE customer_key=? AND note=?').get(key, note)) throw new Error('already_redeemed');
  // note must stay exactly 'bday-redeem-YEAR' so the idempotency check above matches next time.
  db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, note) VALUES (?, 'redeem', 0, ?)`).run(key, note);
  return { ok: true, redeemed: '🎂 ของขวัญวันเกิด', year: bkkYear() };
}
/** Lightweight recognition for the order card (cheap: 2 indexed queries) — name + paid-visit count +
 *  top favourite, so the cashier sees "คุณเอ · มา 6 ครั้ง · ชอบมะม่วง" automatically, no lookup. */
function customerMini(key) {
  if (!key) return null;
  const v = db.prepare(
    `SELECT COUNT(DISTINCT t.id) AS visits FROM tickets t JOIN orders o ON o.ticket_id=t.id
     WHERE (t.line_user_id=? OR t.customer_key=?) AND o.payment_status='paid'`
  ).get(key, key);
  const visits = v.visits || 0;
  if (!visits) return null;   // brand-new / no paid history yet → nothing to recognise
  const fav = db.prepare(
    `SELECT oi.name FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN tickets t ON t.id=o.ticket_id
     WHERE (t.line_user_id=? OR t.customer_key=?) AND oi.kind='base' AND o.payment_status='paid'
     GROUP BY oi.name ORDER BY SUM(oi.qty) DESC, oi.name LIMIT 1`
  ).get(key, key);
  const c = db.prepare('SELECT name FROM customers WHERE line_user_id=?').get(key);
  return { name: c?.name || null, visits, fav: fav?.name || null };
}

/** Cashier "enter phone → see customer". Throws bad_phone on a malformed number. */
export function lookupCustomerByPhone(phone) {
  const d = normalizePhone(phone);
  if (!d) throw new Error('bad_phone');
  return customerProfile('tel:' + d);
}

/** Attach a phone (customer key) + optional name to a pending ticket, creating the customer row so
 *  future orders accrue to this customer (CRM). Works regardless of the loyalty-rewards toggle —
 *  stamps are awarded separately (and only when loyalty is on). Rejected once the order is paid. */
export function attachCustomerToTicket(ticketId, phone, name = null) {
  const d = normalizePhone(phone);
  if (!d) throw new Error('bad_phone');
  const t = db.prepare('SELECT id, line_user_id FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.line_user_id) throw new Error('already_line_customer');
  const order = db.prepare('SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (order && order.payment_status === 'paid') throw new Error('order_already_paid');
  const key = 'tel:' + d;
  const nm = (name || '').toString().trim().slice(0, 80) || null;
  db.transaction(() => {
    db.prepare(`INSERT INTO customers (line_user_id, name) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET name=COALESCE(excluded.name, customers.name)`).run(key, nm);
    db.prepare('UPDATE tickets SET customer_key=?, customer_name=COALESCE(?, customer_name) WHERE id=?').run(key, nm, ticketId);
  })();
  const b = loyaltyBalance(key);
  return { ticketId: t.id, phone: d, key, name: nm, points: b.points, tier: b.tier ? b.tier.emoji : null, stampsPerReward: getStampsPerReward() };
}

/** Tag a new order to a known customer key (from "สั่งให้ลูกค้าคนนี้"). Handles a phone key
 *  ('tel:<digits>') via attachCustomerToTicket, or a LINE id (set directly — cashier-authed). No-op
 *  if already tied / paid. Best-effort: never blocks order creation. */
export function tagOrderCustomer(ticketId, key, name = null) {
  if (!key) return;
  if (String(key).startsWith('tel:')) { try { attachCustomerToTicket(ticketId, key.slice(4), name); } catch { /* best-effort */ } return; }
  try {
    const t = db.prepare('SELECT id, line_user_id FROM tickets WHERE id=?').get(ticketId);
    if (!t || t.line_user_id) return;
    const order = db.prepare('SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
    if (order && order.payment_status === 'paid') return;
    const nm = (name || '').toString().trim().slice(0, 80) || null;
    db.transaction(() => {
      db.prepare(`INSERT INTO customers (line_user_id, name) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET name=COALESCE(excluded.name, customers.name)`).run(key, nm);
      db.prepare('UPDATE tickets SET line_user_id=?, customer_name=COALESCE(?, customer_name) WHERE id=?').run(key, nm, ticketId);
    })();
  } catch { /* best-effort */ }
}

// ---- QR check-in handshake: cashier shows a per-order QR → customer scans with LINE → their LINE
// identity links to THIS order (no phone typing). Tokens live in-memory (short scan window), so no
// migration and they auto-expire; a lost token just means the customer re-scans. ----
const _checkinTokens = new Map();   // ticketId -> { token, exp }
function _newToken() { try { return globalThis.crypto.randomUUID().replace(/-/g, ''); } catch { return 'c' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); } }
/** Cashier asks for a check-in QR for an unpaid, not-yet-LINE order. Returns a fresh token. */
export function startCheckin(ticketId) {
  const t = db.prepare('SELECT id, line_user_id FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.line_user_id) throw new Error('already_line_customer');
  const order = db.prepare('SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (order && order.payment_status === 'paid') throw new Error('order_already_paid');
  const token = _newToken();
  _checkinTokens.set(Number(ticketId), { token, exp: Date.now() + 5 * 60 * 1000 });
  return token;
}
/** Customer's LIFF claims the order after scanning. Verifies the token + that the order is still
 *  unclaimed/unpaid, then links their LINE identity to the ticket and ensures the customer row. */
export function claimTicket(ticketId, lineUserId, token, name = null) {
  const id = Number(ticketId);
  if (!lineUserId) throw new Error('no_identity');
  const rec = _checkinTokens.get(id);
  if (!rec || rec.token !== token || rec.exp < Date.now()) throw new Error('bad_or_expired_qr');
  const t = db.prepare('SELECT id, line_user_id FROM tickets WHERE id=?').get(id);
  if (!t) throw new Error('ticket_not_found');
  if (t.line_user_id) throw new Error('already_claimed');
  const order = db.prepare('SELECT payment_status FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(id);
  if (order && order.payment_status === 'paid') throw new Error('order_already_paid');
  const nm = (name || '').toString().trim().slice(0, 80) || null;
  db.transaction(() => {
    db.prepare(`INSERT INTO customers (line_user_id, name) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET name=COALESCE(excluded.name, customers.name)`).run(lineUserId, nm);
    db.prepare('UPDATE tickets SET line_user_id=?, customer_name=COALESCE(?, customer_name) WHERE id=?').run(lineUserId, nm, id);
  })();
  _checkinTokens.delete(id);
  return { ok: true, ticketId: id, zoneId: db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(id)?.zone_id, profile: customerProfile(lineUserId) };
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
// The welcome bonus's loyalty_moves note — ticketView keys "first order" off this EXACT string, so
// birthday/referral bonus rows (also noted earns on the same order) never masquerade as a welcome.
const WELCOME_NOTE = 'โบนัสต้อนรับออเดอร์แรกผ่านไลน์';
export function awardPoints(orderId) {
  if (!loyaltyEnabled()) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return null;
  const t = db.prepare('SELECT line_user_id, customer_key, customer_name FROM tickets WHERE id=?').get(order.ticket_id);
  // Loyalty key = LINE userId (Pkg 2) OR a phone key 'tel:…' attached at the counter (Pkg 1).
  const loyKey = t && (t.line_user_id || t.customer_key);
  if (!t || !loyKey) return null;
  if (db.prepare("SELECT 1 FROM loyalty_moves WHERE order_id=? AND kind='earn'").get(orderId)) return null;
  // 1 stamp per drink cup (non-topping lines); sweetened drink names don't match the menu
  // catalog so they COALESCE to 'drink' — counted, which is correct.
  const pts = getEarnMode() === 'baht'
    ? Math.floor((order.total || 0) / getBahtPerStar())
    : db.prepare(
        `SELECT COALESCE(SUM(oi.qty),0) c FROM order_items oi LEFT JOIN menu_items mi ON mi.name = oi.name
          WHERE oi.order_id=? AND COALESCE(mi.category,'drink') != 'topping'`
      ).get(orderId).c;
  if (pts <= 0) return null;
  const key = loyKey;
  const name = t.customer_name && !['LINE order', 'Order', 'Walk-in'].includes(t.customer_name) ? t.customer_name : null;
  // First-ever LINE order for this customer? Grant a one-time welcome head-start.
  const isFirst = !db.prepare("SELECT 1 FROM loyalty_moves WHERE customer_key=? AND kind='earn' LIMIT 1").get(key);
  const bonus = isFirst ? getWelcomeBonus() : 0;   // logged with WELCOME_NOTE — ticketView keys "first order" off that note
  // Birthday: the old auto "+10 stamps when ordering on your birthday" is retired — the birthday
  // gift is now a ฿100 free-drink COUPON issued on the birthday morning (see issueBirthdayCoupons),
  // so awarding stamps here too would double-gift.
  const cust = db.prepare('SELECT birthday, referred_by FROM customers WHERE line_user_id=?').get(key);
  const bdayBonus = 0;
  // Referral: on the invited friend's FIRST order, both the friend and the referrer get a bonus.
  const referrerKey = (isFirst && cust && cust.referred_by) ? cust.referred_by : null;
  const refBonus = referrerKey ? getReferralBonus() : 0;
  const total = pts + bonus + refBonus;
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
    if (bonus > 0) db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(key, bonus, orderId, WELCOME_NOTE);
    if (refBonus > 0 && referrerKey) {
      db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(key, refBonus, orderId, 'referral (เพื่อนชวน)');
      db.prepare('UPDATE customers SET points=points+?, lifetime_points=lifetime_points+? WHERE line_user_id=?').run(refBonus, refBonus, referrerKey);
      db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'earn', ?, ?, ?)`).run(referrerKey, refBonus, orderId, 'referral (เพื่อนที่ชวนสั่งครั้งแรก)');
    }
  })();
  if (refBonus > 0 && referrerKey) pushQueue(referrerKey, `👫 เพื่อนที่คุณชวนสั่งครั้งแรกแล้ว! รับ +${refBonus} ดวง 🎉`, null);
  // Convert any freshly-completed stamp card into its 30-day coupon right away, so the customer's
  // "you earned a free drink" moment carries a real coupon (and an expiry date) with it.
  let coupons = [];
  try { coupons = convertReadyRewards(key); } catch { /* never block a payment on conversion */ }
  return { key, name, awarded: pts, bonus, bdayBonus, refBonus, firstOrder: isFirst, balance: loyaltyBalance(key).points, coupons };
}

// ---------- Expiry reminder ----------
// Owner-settable lead time: remind holders of unused wallet coupons this many days before they
// lapse. 0 = off, 14 max. Read/written through the same ⚙ features API as the pickup reminder.
export function getCouponNudgeConfig() {
  return { days: Math.max(0, Math.min(14, Math.round(Number(getSetting('coupon:nudge_days', '2')) || 0))) };
}
export function setCouponNudgeConfig(patch = {}) {
  if (patch.days != null) setSetting('coupon:nudge_days', String(Math.max(0, Math.min(14, Math.round(Number(patch.days) || 0)))));
  return getCouponNudgeConfig();
}
/** Expiry nudge: once a day (after 10:00 BKK), remind holders of unused wallet coupons that expire
 *  within the configured lead time. Sends the SAME coupon Flex card birthday/win-back use — it used
 *  to send the generic queue card with the URL pasted into the body as raw text (no button).
 *  One message PER CUSTOMER, not per coupon: someone holding three lapsing coupons cost three LINE
 *  pushes and read as spam. Each coupon is still nudged only once ever (nudged_at); the per-run cap
 *  now counts messages, and the most urgent customers are served first so the cap can never strand
 *  a coupon that expires today. `force` bypasses the clock gates for tests only — never wired to a route. */
export function nudgeExpiringCoupons({ force = false } = {}) {
  const { days } = getCouponNudgeConfig();
  if (!days) return { nudged: 0, messages: 0 };
  const now = db.prepare(`SELECT date(datetime('now','+7 hours')) d, CAST(strftime('%H', datetime('now','+7 hours')) AS INT) h`).get();
  if (!force) {
    if (now.h < 10) return { nudged: 0, messages: 0 };                                       // never push at night
    if (getSetting('coupon:nudge_last_day', '') === now.d) return { nudged: 0, messages: 0 }; // once per day
  }
  const rows = db.prepare(
    `SELECT id, customer_key, kind, label, free_cap, expires_at FROM customer_coupons
      WHERE used_at IS NULL AND state != 'cancelled' AND nudged_at IS NULL
        AND expires_at >= ? AND expires_at <= date(?, '+${days} days')
        AND customer_key LIKE 'U%'
      ORDER BY expires_at, free_cap DESC, id LIMIT 400`).all(now.d, now.d);
  if (!force) setSetting('coupon:nudge_last_day', now.d);

  // Group per holder, then serve whoever expires soonest first — with a message cap, the customer
  // whose coupon dies today must not lose their slot to one that still has two days left.
  const byCustomer = new Map();
  for (const r of rows) {
    if (!byCustomer.has(r.customer_key)) byCustomer.set(r.customer_key, []);
    byCustomer.get(r.customer_key).push(r);
  }
  const groups = [...byCustomer.values()].sort((a, b) => (a[0].expires_at < b[0].expires_at ? -1 : a[0].expires_at > b[0].expires_at ? 1 : 0)).slice(0, 60);

  const link = shopLink();   // liff.line.me/<id>?zone=… — a bare /liff/ has no zone and dead-ends on "ไม่พบโซน"
  let nudged = 0;
  for (const list of groups) {
    const first = list[0], n = list.length;   // first = soonest to lapse, biggest value on a tie
    for (const r of list) db.prepare(`UPDATE customer_coupons SET nudged_at=datetime('now') WHERE id=?`).run(r.id);
    nudged += n;
    const isFree = first.kind === 'reward';
    try {
      pushCouponFlex(first.customer_key, {
        ...(isFree ? { isReward: true, disc_type: 'reward', freeCap: first.free_cap }
                   : { disc_type: 'amount', disc_value: first.free_cap }),
        couponKind: first.kind,
        label: n > 1 ? `${first.label} และอีก ${n - 1} ใบ` : first.label,
        expiresAt: first.expires_at,
        kicker: '⏰ ใกล้หมดอายุ',
        emoji: '⏰',
        altText: n > 1
          ? `⏰ คูปอง ${n} ใบของคุณใกล้หมดอายุ — ใบแรก ${first.expires_at}`
          : `⏰ คูปอง "${first.label}" ของคุณจะหมดอายุ ${first.expires_at}`,
      }, link,
        n > 1 ? `คุณมีคูปอง ${n} ใบกำลังจะหมดอายุนะคะ อย่าลืมแวะมาใช้ก่อนหมดเขตค่ะ 💛`
              : `คูปองของคุณจะหมดอายุ ${first.expires_at} นี้แล้วนะคะ อย่าลืมแวะมาใช้ก่อนหมดเขตค่ะ 💛`,
        'expiry');
    } catch { /* one bad push must not stop the rest */ }
  }
  return { nudged, messages: groups.length };
}

/** Issue this year's birthday coupon (free drink, value/expiry from the birthday template) to every
 *  customer whose saved birthday is today (Bangkok) — and tell them on LINE. Runs from a periodic
 *  sweep; idempotent per customer per calendar year. */

export function issueBirthdayCoupons() {
  const tpl = couponTemplate('birthday');
  if (!loyaltyEnabled() || !tpl.on) return { issued: 0 };
  const md = bkkMonthDay(), yr = bkkYear();
  const rows = db.prepare(
    `SELECT c.line_user_id AS key FROM customers c
      WHERE c.birthday IS NOT NULL AND substr(c.birthday, -5) = ?
        AND NOT EXISTS (SELECT 1 FROM customer_coupons cc
                         WHERE cc.customer_key = c.line_user_id AND cc.kind='birthday'
                           AND strftime('%Y', datetime(cc.issued_at, '+7 hours')) = ?)`
  ).all(md, yr);
  const expiresAt = db.prepare(`SELECT date(datetime('now','+7 hours'),'+' || ? || ' days') d`).get(tpl.days).d;
  // When bound, the wallet shows the coupon's own name (rename it on the coupon page → every future
  // gift follows). coupon_id itself is deliberately NOT stored on these rows: the one-claim-per-
  // customer unique index would then block the SAME customer's gift next year.
  const bdayLabel = tpl.couponLabel || `ของขวัญวันเกิด — ฟรี 1 แก้ว (ไม่เกิน ฿${tpl.value})`;
  for (const r of rows) {
    db.prepare(`INSERT INTO customer_coupons (customer_key, kind, label, free_cap, expires_at, source) VALUES (?, 'birthday', ?, ?, ?, 'birthday')`)
      .run(r.key, bdayLabel, tpl.value, expiresAt);
    try {
      pushCouponFlex(r.key,
        { isReward: true, disc_type: 'reward', couponKind: 'birthday', freeCap: tpl.value, label: bdayLabel, expiresAt },
        shopLink(), '🎂 สุขสันต์วันเกิดค่ะ! ทางร้านมีของขวัญให้คุณ 💛', 'birthday');
    } catch { /* push is best-effort */ }
  }
  return { issued: rows.length };
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
// Merchandising badge shown on the tile (decorative; '' clears it). Validated against a fixed set.
const VALID_BADGES = ['new', 'promo', 'hot', 'rec', 'free'];
const normBadge = (b) => (VALID_BADGES.includes(b) ? b : null);

export function addMenuItem({ name, name_en, price, image, category, badge }) {
  const n = (name || '').toString().trim().slice(0, 80);
  if (!n) throw new Error('name_required');
  const p = Math.max(0, Number(price) || 0);
  const cat = category === 'topping' ? 'topping' : 'drink';
  const s = db.prepare('SELECT COALESCE(MAX(sort),0)+1 AS s FROM menu_items').get().s;
  const info = db.prepare('INSERT INTO menu_items (name, name_en, price, image, category, sort, badge) VALUES (?,?,?,?,?,?,?)')
    .run(n, (name_en || '').toString().slice(0, 80) || null, p, (image || '').toString().slice(0, IMG_CAP) || null, cat, s, normBadge(badge));
  return db.prepare('SELECT * FROM menu_items WHERE id=?').get(info.lastInsertRowid);
}
// Append-only price trail. A margin report from last month is only readable against the price that
// was in force THEN — and "why is this item suddenly less profitable" needs a date and a name.
export function priceHistory(itemId = null, limit = 100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return itemId
    ? db.prepare('SELECT * FROM price_history WHERE item_id=? ORDER BY at DESC, id DESC LIMIT ?').all(Number(itemId), n)
    : db.prepare('SELECT * FROM price_history ORDER BY at DESC, id DESC LIMIT ?').all(n);
}
export function updateMenuItem(id, { name, name_en, price, image, active, soldout, category, badge }, actor = null) {
  const cur = db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
  if (!cur) throw new Error('item_not_found');
  const n = name != null ? (name.toString().trim().slice(0, 80) || cur.name) : cur.name;
  const en = name_en != null ? (name_en.toString().slice(0, 80) || null) : cur.name_en;
  const p = price != null ? Math.max(0, Number(price) || 0) : cur.price;
  const img = image != null ? (image.toString().slice(0, IMG_CAP) || null) : cur.image;
  const cat = category != null ? (category === 'topping' ? 'topping' : 'drink') : cur.category;
  const a = active != null ? (active ? 1 : 0) : cur.active;
  const so = soldout != null ? (soldout ? 1 : 0) : cur.soldout;
  const bd = badge !== undefined ? normBadge(badge) : (cur.badge || null);
  db.prepare('UPDATE menu_items SET name=?, name_en=?, price=?, image=?, category=?, active=?, soldout=?, badge=? WHERE id=?').run(n, en, p, img, cat, a, so, bd, id);
  // Record the change, not the save: editing a name or a photo must not fill the trail with noise.
  if (Number(p) !== Number(cur.price)) {
    try {
      db.prepare('INSERT INTO price_history (item_id, item_name, old_price, new_price, actor_id, actor_name) VALUES (?,?,?,?,?,?)')
        .run(id, n, cur.price, p, actor?.id || null, actor?.name || null);
    } catch { /* trail is best-effort: never block a price change */ }
  }
  return db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
}
export function deleteMenuItem(id) {
  db.prepare('DELETE FROM menu_items WHERE id=?').run(id);
  return { ok: true };
}

/** Reorder a menu item up/down WITHIN its category (drinks among drinks, toppings among toppings).
 *  This is the order the customer/cashier see in the ordering grid (listMenu ORDER BY sort, id).
 *  Normalizes the whole category's sort to 0..n-1 on each move so ties never block a swap. */
export function moveMenuItem(id, dir) {
  const item = db.prepare('SELECT id, category FROM menu_items WHERE id=?').get(id);
  if (!item) throw new Error('not_found');
  const list = db.prepare('SELECT id FROM menu_items WHERE category=? ORDER BY sort, id').all(item.category).map((r) => r.id);
  const idx = list.indexOf(Number(id));
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swap < 0 || swap >= list.length) return { ok: true, moved: false };   // already at the edge
  [list[idx], list[swap]] = [list[swap], list[idx]];
  const tx = db.transaction(() => { const upd = db.prepare('UPDATE menu_items SET sort=? WHERE id=?'); list.forEach((mid, i) => upd.run(i, mid)); });
  tx();
  return { ok: true, moved: true };
}
/** Set a whole category's display order from a drag-and-drop reorder (array of ids, top→bottom). */
export function setMenuOrder(ids) {
  const arr = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0);
  if (!arr.length) return { ok: true, count: 0 };
  const cats = new Set(db.prepare(`SELECT DISTINCT category FROM menu_items WHERE id IN (${arr.map(() => '?').join(',')})`).all(...arr).map((r) => r.category));
  if (cats.size > 1) throw new Error('mixed_categories');   // never let a reorder mix drinks + toppings
  const tx = db.transaction(() => { const upd = db.prepare('UPDATE menu_items SET sort=? WHERE id=?'); arr.forEach((id, i) => upd.run(i, id)); });
  tx();
  return { ok: true, count: arr.length };
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
export function customerSuggestions(lineUserId, opts = {}) {
  if (!lineUserId) return { known: false };
  const branchId = Number(opts.branchId) || 0;
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
  // "Order the usual?" may only offer what the ORDER endpoint would actually accept. The global
  // soldout flag alone is not that test: a branch sells out on its own (branch_menu) and a
  // BOM-costed drink runs out when its ingredients do (menuMakeable). Offering one anyway walks
  // the customer into item_soldout with a cart that then gets thrown away (CUS-C5).
  const ov = branchId
    ? new Map(db.prepare('SELECT item_id, enabled, soldout FROM branch_menu WHERE branch_id=?').all(branchId).map((r) => [r.item_id, r]))
    : new Map();
  const mk = menuMakeable();
  const unavailable = (f) => {
    if (f.soldout === 1) return true;
    if (f.item_id == null) return false;
    const o = ov.get(f.item_id);
    if (o && (!o.enabled || o.soldout)) return true;
    return mk.has(f.item_id) && mk.get(f.item_id) <= 0;
  };
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
    favourites: favourites.map((f) => ({ name: f.name, qty: f.qty, times: f.times, itemId: f.item_id, price: f.price, image: f.image, soldout: unavailable(f) })),
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
/** Edit a still-unpaid order's items in place (change drink / sweetness / toppings) instead of
 *  cancel-and-rekey. Replaces all order_items + recomputes total. Guarded: not paid, not void, and
 *  nothing collected yet (paid_amount 0). Stock isn't touched here — it deducts at payment. */
export function editOrderItems(ticketId, items, opts = {}) {
  const { actorId = null } = opts;
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') throw new Error('already_paid');
  if (order.payment_status === 'void') throw new Error('order_void');
  if ((order.paid_amount || 0) > 0) throw new Error('has_partial_payment');
  const lines = (Array.isArray(items) ? items : [])
    .map((it) => ({ name: (it.name || '').toString().slice(0, 60), price: Math.max(0, Number(it.price) || 0), qty: Math.max(1, Math.min(99, Math.round(Number(it.qty) || 1))) }))
    .filter((it) => it.name);
  if (!lines.length) throw new Error('empty_order');
  const total = lines.reduce((s, it) => s + it.price * it.qty, 0);
  const toppingNames = new Set(db.prepare("SELECT name FROM menu_items WHERE category='topping'").all().map((r) => r.name));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(order.id);
    const ins = db.prepare('INSERT INTO order_items (order_id, name, price, qty, kind) VALUES (?,?,?,?,?)');
    for (const it of lines) ins.run(order.id, it.name, it.price, it.qty, toppingNames.has(it.name) ? 'addon' : 'base');
    // Recompute the free-giveaway discount for the new item set. Don't clobber a manual bill
    // discount the cashier set by hand — only re-manage the auto 'ของแถมฟรี' one (or a clean bill).
    const keepManual = (order.discount || 0) > 0 && order.discount_reason !== FREE_GIVEAWAY_REASON;
    const freeDisc = freeGiveawayDiscount(lines, total);
    const newDisc = keepManual ? Math.min(order.discount, total) : freeDisc;
    const newReason = keepManual ? order.discount_reason : (freeDisc > 0 ? FREE_GIVEAWAY_REASON : null);
    db.prepare('UPDATE orders SET total=?, discount=?, discount_reason=? WHERE id=?').run(total, newDisc, newReason, order.id);
  });
  tx();
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'order_edited', amount: total, actor: actorId, meta: {} });
  return { ok: true, total, ticketId: Number(ticketId) };
}

// Free-badge giveaway: any menu item / topping flagged badge='free' is recorded at its REAL price
// (so gross item + topping revenue and cup/topping counts stay accurate) but an equal order-level
// discount nets it to ฿0 for the customer. Server-authoritative — it reads the menu badge, never a
// client-supplied flag — so it can't be spoofed. Clamped to the order total so net can't go negative.
const FREE_GIVEAWAY_REASON = 'ของแถมฟรี';
function freeGiveawayDiscount(lines, total) {
  const freeNames = db.prepare("SELECT name FROM menu_items WHERE badge='free'").all().map((r) => r.name);
  if (!freeNames.length) return 0;
  // A drink line carries a sweetness suffix ("Name · หวาน 50%"); toppings are sent bare. Match the
  // bare name OR a "Name · …" prefix so a free drink at non-default sweetness is still detected.
  const isFree = (nm) => freeNames.some((fn) => nm === fn || nm.startsWith(fn + ' · '));
  let d = 0;
  for (const it of lines) if (isFree(it.name)) d += it.price * it.qty;
  return Math.min(Math.round(d * 100) / 100, Math.max(0, total));
}

/** The catalog price a submitted line is really worth here, or null when the item cannot be
 *  ordered on this channel/branch at all (unknown, retired, or switched off for the branch).
 *  Drink lines carry the customer's sweetness choice as a " · หวาน X%" suffix and sweetness never
 *  changes the price, so the lookup matches on the base name. */
function catalogPrice(rawName, { channelId = null, branchId = null } = {}) {
  const base = String(rawName || '').split(' · ')[0].trim();
  if (!base) return null;
  const item = db.prepare('SELECT id FROM menu_items WHERE name=? AND active=1').get(base);
  if (!item) return null;
  if (branchId) {
    const bm = db.prepare('SELECT enabled FROM branch_menu WHERE branch_id=? AND item_id=?').get(branchId, item.id);
    if (bm && !bm.enabled) return null;
  }
  const p = priceFor(item.id, { channelId, branchId });
  return p == null ? null : r2(p);
}
export function createOrder(zoneId, items, opts = {}) {
  const { source = 'cashier', lineUserId = null, customerName = null, actorId = null, channelId = null, clientToken = null, couponCode = null } = opts;
  let prepayOnly = false;   // set below for a customer on the no-show prepay tier
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
  // Off-hours / manually-closed branch: reject CUSTOMER (LINE) orders only — reachable from the
  // member card / deep link even when the LIFF order button is hidden. The cashier POS keeps
  // selling to walk-ins outside opening hours (owner decision 2026-07: ขายนอกเวลาได้).
  const _store = db.prepare('SELECT * FROM stores WHERE id=?').get(zone.store_id);
  if (source === 'customer' && _store && (_store.is_open === 0 || !isStoreOpenRow(_store))) throw new Error('store_closed');
  // Online ordering switched off, or every till has gone quiet (shop internet down). The counter
  // keeps selling either way — only the LINE channel closes.
  if (source === 'customer') { const _p = orderingPaused(); if (_p.paused) throw new Error(_p.code); }

  // A LINE customer may only hold one open order at a time (prevents accidental
  // double-submits creating duplicate queue numbers). Return the existing one.
  if (source === 'customer' && lineUserId) {
    const existing = findActiveTicket(zoneId, lineUserId);
    if (existing) {
      const e = new Error('already_in_queue');
      e.ticketId = existing.id; e.code = existing.code;
      throw e;
    }
    // No-show strikes (walk-ins at the counter are unaffected — the cashier path never carries a
    // lineUserId with source='cashier'):
    //   blocked → the online channel is closed for them
    //   prepay  → they may order, but the queue number waits for payment even when the shop runs
    //             queue-first, so nothing is made before the money is in.
    const ns = noshowStrikes(lineUserId);
    if (ns.blocked) { const e = new Error('noshow_blocked'); e.strikes = ns.strikes; e.limit = ns.blockLimit; throw e; }
    prepayOnly = ns.prepay;
  }

  // SELF-SERVE ORDERS PRICE THEMSELVES FROM THE CATALOG. The LIFF posts the price it displayed and
  // the endpoint is public, so a modified client could name its own price — and the recorded bill,
  // the P&L, the stamps and the COGS all followed that number.
  // Cashier lines keep the submitted price on purpose: a till operator legitimately overrides
  // (staff drink, replacement cup, agreed discount) and is authenticated, PIN-gated and audited.
  if (source === 'customer') {
    // A sold-out drink was orderable + payable via reorder / stale cart because catalogPrice only
    // checked active+enabled, never soldout or BOM stock (CUS-C2). The disabled dish-card was the
    // ONLY guard. Re-check both here — the same server-side gate that re-prices the line.
    const makeable = menuMakeable();
    const soldByBranch = new Map(
      db.prepare('SELECT item_id, soldout FROM branch_menu WHERE branch_id=?').all(zone.store_id).map((r) => [r.item_id, r.soldout])
    );
    const needByItem = new Map();   // cumulative qty per item across the cart (2 lines of the same drink)
    for (const it of lines) {
      const base = String(it.name || '').split(' · ')[0].trim();
      const p = catalogPrice(it.name, { channelId, branchId: zone.store_id });
      if (p == null) throw new Error('item_unavailable');
      it.price = p;
      const mi = db.prepare('SELECT id, soldout FROM menu_items WHERE name=? AND active=1').get(base);
      if (mi) {
        const soldout = soldByBranch.has(mi.id) ? soldByBranch.get(mi.id) : mi.soldout;
        if (soldout) throw new Error('item_soldout');
        if (makeable.has(mi.id)) {
          const need = (needByItem.get(mi.id) || 0) + (Number(it.qty) || 1);
          needByItem.set(mi.id, need);
          if (makeable.get(mi.id) < need) throw new Error('item_soldout');
        }
      }
    }
  }
  const total = lines.reduce((s, it) => s + it.price * it.qty, 0);
  const label = customerName || (source === 'customer' ? 'LINE order' : 'Order');
  // Classify each line as a base drink or an addon (topping) for exact addon reporting, and pin
  // each line to its catalog id so a later menu RENAME can't detach it from recipe/stock/history.
  const toppingNames = new Set(
    db.prepare("SELECT name FROM menu_items WHERE category='topping'").all().map((r) => r.name)
  );
  const idByName = new Map(db.prepare('SELECT id, name FROM menu_items').all().map((r) => [r.name, r.id]));
  const catalogIdOf = (nm) => idByName.get(String(nm).split(' · ')[0].trim()) ?? null;
  // Pay-first model: create the ticket in 'pending' state with NO queue number yet.
  // The real queue number is issued only once payment is confirmed (assignQueueNumber),
  // so abandoned/unpaid orders never consume a number and the kitchen only sees paid work.
  const dedup = source === 'customer' && lineUserId;
  // Idempotency fast-path: a retried request carrying a token we've already accepted returns the
  // SAME order (no duplicate ticket). The conditional INSERT inside the tx closes the race window.
  if (clientToken) {
    const seen = db.prepare('SELECT * FROM tickets WHERE client_token=?').get(clientToken);
    if (seen) { const o = db.prepare('SELECT total FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(seen.id);
      return { ticket: seen, total: o?.total ?? 0, idempotent: true }; }
  }
  const tx = db.transaction(() => {
    // Atomic insert. Each branch is a single conditional INSERT so two near-simultaneous submits
    // (double-tap / cold-start retry / reload) can never both create a ticket.
    let tinfo;
    if (clientToken && !dedup) {
      // Idempotent on the bill token: create only if this token is unused.
      tinfo = db.prepare(
        `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, status, client_token)
         SELECT ?,?,0,'',1,?,?,'pending',?
         WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE client_token=?)`
      ).run(zone.store_id, zoneId, lineUserId, label, clientToken, clientToken);
      if (tinfo.changes === 0) return { idempotent: true };   // token already used → return existing (below)
    } else if (dedup) {
      // LINE customer may hold only one open order: insert only if they have NO active order.
      tinfo = db.prepare(
        `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, status, client_token)
         SELECT ?,?,0,'',1,?,?,'pending',?
         WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE zone_id=? AND line_user_id=? AND status IN ('pending','waiting','called'))`
      ).run(zone.store_id, zoneId, lineUserId, label, clientToken, zoneId, lineUserId);
      if (tinfo.changes === 0) {                 // a race lost: an active order already exists
        const ex = findActiveTicket(zoneId, lineUserId);
        const e = new Error('already_in_queue');
        e.ticketId = ex?.id; e.code = ex?.code;
        throw e;
      }
    } else {
      tinfo = db.prepare(
        `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name, status, client_token)
         VALUES (?,?,?,?,?,?,?,'pending',?)`
      ).run(zone.store_id, zoneId, 0, '', 1, lineUserId, label, clientToken);
    }
    const freeDisc = freeGiveawayDiscount(lines, total);
    const oinfo = db.prepare('INSERT INTO orders (ticket_id, total, source, branch_id, created_by, channel_id, discount, discount_reason) VALUES (?,?,?,?,?,?,?,?)')
      .run(tinfo.lastInsertRowid, total, source, zone.store_id, actorId, channelId, freeDisc, freeDisc > 0 ? FREE_GIVEAWAY_REASON : null);
    const ins = db.prepare('INSERT INTO order_items (order_id, name, price, qty, kind, menu_item_id) VALUES (?,?,?,?,?,?)');
    for (const it of lines) ins.run(oinfo.lastInsertRowid, it.name, it.price, it.qty, toppingNames.has(it.name) ? 'addon' : 'base', catalogIdOf(it.name));
    // Queue-first: assign the queue number IN THE SAME TRANSACTION as the order. Previously this ran
    // in a SEPARATE transaction after the order committed — on prod (Turso) a stale write-stream could
    // make that second tx fail while the order tx had already committed, stranding the order in
    // "รอชำระเงิน" with no number against the toggle. Atomic = an order is never created-but-unnumbered.
    // prepayOnly forces the pay-first path for THIS order only: no number until the money lands,
    // so a repeat no-show can still order but can never have a drink made on credit.
    if (getQueueFirst() && !prepayOnly) {
      const zr = db.prepare('SELECT last_number, prefix FROM zones WHERE id=?').get(zoneId);
      const next = (zr.last_number || 0) + 1;
      db.prepare('UPDATE zones SET last_number=? WHERE id=?').run(next, zoneId);
      db.prepare("UPDATE tickets SET number=?, code=?, status='waiting', numbered_at=datetime('now') WHERE id=? AND number=0")
        .run(next, code(zr.prefix, next), tinfo.lastInsertRowid);
      // Inside the same transaction as the numbering: a ticket can never exist with the lucky
      // number but no prize, and the prize can never be attached to a number that rolled back.
      markLuckyIfWon(tinfo.lastInsertRowid, next, lineUserId);
    }
    logSaleEvent({ branchId: zone.store_id, ticketId: tinfo.lastInsertRowid, orderId: oinfo.lastInsertRowid, type: 'order_created', amount: total, actor: actorId, meta: { source } });
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id=?').get(tinfo.lastInsertRowid), total, prepayOnly };
  });
  // Run the whole create+number transaction with Turso resilience: a stale write-stream (free instance
  // waking from idle) throws on the first write — reconnect + retry ONCE. The clientToken/dedup
  // conditional inserts keep the retry idempotent (no duplicate order). queue-first numbering is now
  // INSIDE this tx, so the retry re-numbers atomically too — an order is never left unnumbered.
  let r;
  try { r = tx(); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (DURABLE && STREAM_STALE.test(msg)) {
      console.error('[order] createOrder hit a stale Turso stream — reconnecting + retrying once:', msg);
      reconnectDb();
      r = tx();
    } else throw e;
  }
  if (r.idempotent && !r.ticket) {   // token race lost inside the tx → return the winning order
    const ex = db.prepare('SELECT * FROM tickets WHERE client_token=?').get(clientToken);
    const o = ex ? db.prepare('SELECT total FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ex.id) : null;
    return { ticket: ex, total: o?.total ?? 0, idempotent: true };
  }

  // Apply a customer-selected coupon — the server re-validates (source of truth) + records the use.
  // A now-invalid coupon (expired between pick and confirm) is ignored so the order still stands.
  // "CCOUP:<id>" = an issued customer coupon (stamp-card conversion / birthday gift); the legacy
  // "REWARD:<id>" pseudo-code still routes to the balance-based redemption for old clients.
  if (couponCode && r.ticket && !r.idempotent) {
    try {
      if (couponCode.startsWith('CCOUP:')) redeemCustomerCoupon(r.ticket.id, Number(couponCode.slice(6)), null);
      else if (couponCode.startsWith('REWARD:')) redeemRewardOnOrder(r.ticket.id, Number(couponCode.slice(7)), null);
      else applyCouponToOrder(r.ticket.id, couponCode, lineUserId);
    } catch { /* order stands without the discount */ }
  }

  // Remember this LINE customer for next-visit reorder suggestions (best-effort, deferred so the
  // extra write doesn't add a remote round-trip to the order response).
  if (source === 'customer' && lineUserId) setImmediate(() => { try { recordCustomerOrder(lineUserId, customerName); } catch { /* best-effort */ } });

  // Self-order LINE notice — queue-first already has a number, otherwise pay-to-get-number.
  if (source === 'customer' && lineUserId) {
    const msg = (r.ticket && r.ticket.number > 0)
      ? `🎫 รับออเดอร์ + รับคิวแล้ว!\nหมายเลขคิวของคุณ: ${r.ticket.code}\nยอด ฿${r.total} — กรุณาชำระเงินก่อนรับเครื่องดื่มนะคะ 🙏`
      : `🧾 รับออเดอร์แล้ว ยอด ฿${r.total}\nกรุณาชำระเงินให้เรียบร้อย แล้วระบบจะออกหมายเลขคิวให้ทันที 🎫`;
    pushQueue(lineUserId, msg, queueLink(zoneId), 'ชำระเงิน / ดูออเดอร์', 'queue');
  }
  return r;
}

// A dropped Turso/libSQL Hrana write-stream surfaces as these on the next write (the free instance's
// embedded-replica stream expires while idle). Same matcher the midnight reset uses.
const STREAM_STALE = /stream not found|stream expired|hrana|stream_expired|not found|404/i;
/** Issue the queue number, surviving a stale Turso write-stream: reconnect + retry once, then LOG if
 *  it still fails (returns null) so a queue-first order is never silently stranded in "รอชำระเงิน".
 *  No-op overhead on local (node:sqlite) — reconnectDb returns false there. */
function assignQueueNumberResilient(ticketId) {
  try { return assignQueueNumber(ticketId); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (DURABLE && STREAM_STALE.test(msg)) {
      console.error('[order] queue-first numbering hit a stale Turso stream — reconnecting + retrying once:', msg);
      try { reconnectDb(); return assignQueueNumber(ticketId); }
      catch (e2) { console.error('[order] queue-first numbering STILL failed after reconnect — order stays in รอชำระเงิน:', String((e2 && e2.message) || e2)); return null; }
    }
    console.error('[order] queue-first numbering failed — order stays in รอชำระเงิน:', msg);
    return null;
  }
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
    db.prepare("UPDATE tickets SET number=?, code=?, status='waiting', numbered_at=datetime('now') WHERE id=? AND number=0")
      .run(next, code(cur.prefix, next), ticketId);
    return db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  })();
}

/** Cashier marks a ticket's order paid (collected cash / PromptPay at the counter).
 *  opts.actorId = staff who took payment; opts.method = cash|promptpay|slip|other.
 *  Under the pay-first model this is also what ISSUES the queue number. */
/** Record one tender leg (a split bill = several rows). kind='payment' stores +amount, 'refund'
 *  stores -amount. A client_token makes a retried leg idempotent (pay-partial double-tap on flaky
 *  wifi). Returns true if a row was written, false if it was a duplicate token. */
// CASH-10: a client can POST any string as the pay method; an unknown one (e.g. 'banana') would slip
// into the ledger + orders.payment_method and never match a tender bucket, silently breaking the
// drawer/tender reconciliation. Collapse anything that isn't a configured tender code (dynamic — never
// rejects a real tender the owner set up) or an always-valid built-in down to 'other'. null/''
// is preserved so "keep the existing payment_method" (COALESCE on update) still works.
const BUILTIN_METHODS = new Set(['cash', 'other', 'reward', 'slip']);
function normalizeMethod(m) {
  if (m == null || m === '') return m;
  const k = String(m).trim().toLowerCase().slice(0, 24);
  if (BUILTIN_METHODS.has(k)) return k;
  try { if (db.prepare('SELECT 1 FROM tenders WHERE code=?').get(k)) return k; } catch { /* fall through to other */ }
  return 'other';
}
function recordPaymentLeg({ orderId, branchId = null, method = 'cash', amount, kind = 'payment', actorId = null, clientToken = null }) {
  const amt = Math.round(Math.abs(Number(amount) || 0) * 100) / 100;
  if (!amt) return false;
  try {
    const r = db.prepare(
      `INSERT INTO order_payments (order_id, branch_id, method, amount, kind, client_token, actor_id) VALUES (?,?,?,?,?,?,?)`
    ).run(orderId, branchId, method || 'cash', kind === 'refund' ? -amt : amt, kind === 'refund' ? 'refund' : 'payment', clientToken, actorId);
    return r.changes > 0;
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return false;   // duplicate token = already applied, not an error
    throw e;
  }
}

// ---------- VAT / tax invoice (3D) ----------
// Dormant until the owner switches it on (they fill the tax id after registering for VAT). When on,
// every paid order takes the next number in an UNBROKEN sequence (Thai tax law) and can print an
// abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) with the VAT split out. Prices are treated as
// VAT-INCLUSIVE by default — the Thai retail norm (the shelf price already contains the 7%).
export function vatEnabled() { return getSetting('vat:enabled', '0') === '1'; }
export function getVatConfig() {
  return {
    enabled: vatEnabled(),
    taxId: getSetting('vat:tax_id', '') || '',
    rate: Number(getSetting('vat:rate', '7')) || 7,
    inclusive: getSetting('vat:inclusive', '1') === '1',
    bizName: getSetting('vat:biz_name', '') || '',
    bizAddress: getSetting('vat:biz_address', '') || '',
    prefix: getSetting('vat:prefix', '') || '',
    seq: Number(getSetting('vat:seq', '0')) || 0,
  };
}
export function setVatConfig(patch = {}) {
  if (patch.enabled != null) setSetting('vat:enabled', patch.enabled ? '1' : '0');
  if (patch.taxId != null) setSetting('vat:tax_id', String(patch.taxId).replace(/\D/g, '').slice(0, 13));  // 13-digit Thai tax id, digits only
  if (patch.rate != null) setSetting('vat:rate', String(Math.max(0, Math.min(30, Number(patch.rate) || 0))));
  if (patch.inclusive != null) setSetting('vat:inclusive', patch.inclusive ? '1' : '0');
  if (patch.bizName != null) setSetting('vat:biz_name', String(patch.bizName).slice(0, 200));
  if (patch.bizAddress != null) setSetting('vat:biz_address', String(patch.bizAddress).slice(0, 400));
  if (patch.prefix != null) setSetting('vat:prefix', String(patch.prefix).replace(/[^\w\-/]/g, '').slice(0, 12));
  // seq lets the owner align with an existing paper book, but can never go BELOW what's been issued
  // (that would reuse a number — illegal). It only ever moves forward.
  if (patch.seq != null) setSetting('vat:seq', String(Math.max(Number(getSetting('vat:seq', '0')) || 0, Math.floor(Number(patch.seq) || 0))));
  return getVatConfig();
}
// Atomic, unbroken increment — single-writer SQLite + a transaction guarantee no sale gets a
// duplicate number and none is skipped.
function nextInvoiceNo() {
  return db.transaction(() => {
    const n = (Number(getSetting('vat:seq', '0')) || 0) + 1;
    setSetting('vat:seq', String(n));
    return `${getSetting('vat:prefix', '') || ''}${String(n).padStart(6, '0')}`;
  })();
}
// Assign a number to a paid order ONCE (idempotent). Never throws — invoicing must not break a sale.
function assignInvoiceForOrder(orderId) {
  try {
    const o = db.prepare('SELECT invoice_no FROM orders WHERE id=?').get(orderId);
    if (!o || o.invoice_no) return o ? o.invoice_no : null;
    const no = nextInvoiceNo();
    db.prepare('UPDATE orders SET invoice_no=? WHERE id=? AND invoice_no IS NULL').run(no, orderId);
    return no;
  } catch { return null; }
}
// Abbreviated-tax-invoice payload for a paid order: VAT split out of the amount actually charged
// (order total net of discount).
export function taxInvoiceForOrder(ticketId) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return null;
  const cfg = getVatConfig();
  const charged = r2((order.total || 0) - (order.discount || 0));
  const vat = cfg.inclusive ? r2(charged * cfg.rate / (100 + cfg.rate)) : r2(charged * cfg.rate / 100);
  const net = cfg.inclusive ? r2(charged - vat) : charged;
  const total = cfg.inclusive ? charged : r2(charged + vat);
  const items = db.prepare('SELECT name, price, qty FROM order_items WHERE order_id=?').all(order.id);
  return {
    invoiceNo: order.invoice_no || null, issued: !!order.invoice_no, paid: order.payment_status === 'paid',
    dateTime: order.paid_at || null, taxId: cfg.taxId, bizName: cfg.bizName, bizAddress: cfg.bizAddress,
    rate: cfg.rate, inclusive: cfg.inclusive, items, net, vat, total,
  };
}

export function setOrderPaid(ticketId, opts = {}) {
  const { actorId = null, method: rawMethod = null, skipLoyalty = false, _skipLeg = false } = opts;
  const method = normalizeMethod(rawMethod);   // CASH-10: reject garbage methods before they hit the ledger
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  // Idempotent: an already-paid order returns its existing result unchanged, so a retried
  // combined create+pay never double-deducts stock, double-awards loyalty, or resets paid_at.
  if (order.payment_status === 'paid') {
    const tk = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
    return { ok: true, ticketId: Number(ticketId), total: order.total, loyalty: null, code: tk?.code || null, number: tk?.number || null, alreadyPaid: true };
  }
  if (order.payment_status === 'void') throw new Error('order_void');
  // The status read above is not atomic — a void landing between the read and this write would be
  // silently overwritten, turning a cancelled order back into a sale. The predicate settles it.
  // paid_amount = what was actually collected. It was never set on a normal full payment, so a
  // fully-paid bill reported 0 (or a stale partial) to anything reading the column.
  const paidNow = db.prepare(`UPDATE orders SET payment_status='paid', paid_at=datetime('now'), paid_by=?, payment_method=COALESCE(?, payment_method), paid_amount=ROUND(total - COALESCE(discount,0), 2) WHERE id=? AND payment_status NOT IN ('paid','void')`)
    .run(actorId, method, order.id);
  if (!paidNow.changes) throw new Error('order_void');
  // Record the tender leg for the drawer/tender reconciliation. Skipped when called from payPartial's
  // settle (the partial legs already cover the full net — else the settling amount is double-counted).
  if (!_skipLeg) recordPaymentLeg({ orderId: order.id, branchId: order.branch_id, method: method || 'cash', amount: order.total - (order.discount || 0), kind: 'payment', actorId });
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'paid', amount: order.total, actor: actorId, meta: { method: method || 'cash' } });
  if (vatEnabled()) assignInvoiceForOrder(order.id);   // 3D: unbroken tax-invoice number, tied to the sale

  // Now that payment is confirmed, issue the queue number (idempotent) and tell the customer.
  // Resilient against a stale Turso stream (reconnect + retry + log) so a PAID order never ends up
  // without a number; falls back to the current ticket row if numbering ultimately fails.
  let ticket = assignQueueNumberResilient(Number(ticketId)) || db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  // Auto-deduct ingredient stock per recipe (dormant until recipes are defined).
  deductStockForOrder(order);
  // Auto-earn loyalty stamps for a paid LINE order (no-op for cashier/walk-in or if disabled).
  // skipLoyalty = a fully-redeemed (free) order shouldn't earn new stamps on the free cup.
  let loyalty = null;
  if (!skipLoyalty) { try { loyalty = awardPoints(order.id); } catch { /* never block a payment on loyalty */ } }
  if (ticket && ticket.line_user_id) {
    const ahead = aheadCount(ticket);
    // Phase 4 #2: drop a come-back coupon into their wallet on purchase (dormant unless the owner
    // enabled it). Mentioned in the confirmation below so it rides the existing push — no extra LINE cost.
    let bounce = null; try { bounce = issueBounceBack(ticket.line_user_id); } catch { /* never block a payment */ }
    // Phase 4 #3: advance the daily-visit streak; award a bonus coupon on the Nth day in a row.
    let streak = null; try { streak = bumpStreak(ticket.line_user_id); } catch { /* never block a payment */ }
    // Order-status progress card (LINE-MAN style): stage 2 = order in, being made.
    let sub = `ชำระเงินเรียบร้อย ฿${order.total} · คิวรอก่อนหน้า ${ahead}`;
    if (loyalty && loyalty.awarded != null) {
      // Recognition: greet returning customers, show stamps earned + progress to the next free drink.
      const per = getStampsPerReward();
      const bal = loyalty.balance || 0;
      const free = Math.floor(bal / per);
      const bonusTxt = (loyalty.bonus ? ` (+${loyalty.bonus} ดวงต้อนรับ! 🎁)` : '') + (loyalty.bdayBonus ? ` (+${loyalty.bdayBonus} ดวงวันเกิด! 🎂)` : '');
      const greet = loyalty.name ? `ขอบคุณค่ะคุณ ${loyalty.name} 💛\n` : '';
      sub = greet + sub + `\n⭐ ได้ ${loyalty.awarded} ดวง${bonusTxt} · สะสมรวม ${bal} ดวง`;
      sub += (loyalty.coupons && loyalty.coupons.length)
        ? `\n🎉 สะสมครบ ${per} ดวง! รับคูปองฟรี 1 ${UNIT} — เลือกใช้ได้ในเมนูคูปอง (ถึง ${loyalty.coupons[0].expiresAt})`
        : (free >= 1
          ? `\n🎉 ครบ ${per} ดวงแล้ว! แจ้งพนักงานเพื่อรับของรางวัลฟรีได้เลยในออเดอร์ถัดไป`
          : `\n🥤 อีก ${per - bal} ${UNIT} ได้ฟรี 1 ${UNIT}!`);
    } else {
      sub += `\nเราจะแจ้งเตือนเมื่อเครื่องดื่มใกล้พร้อมค่ะ`;
    }
    if (bounce && bounce.issued) sub += `\n🎁 ${bounce.label} — เก็บไว้ในเมนูคูปองแล้ว ใช้ได้ถึง ${bounce.expiresAt}`;
    if (streak && streak.issued) sub += `\n🔥 มาต่อเนื่อง ${streak.target} วันติด! รับ ${streak.label} — เก็บในเมนูคูปองแล้ว ใช้ได้ถึง ${streak.expiresAt}`;
    pushStage(ticket.line_user_id, { stage: 2, title: 'รับออเดอร์แล้ว กำลังทำ', code: ticket.code, subtitle: sub,
      link: queueLink(ticket.zone_id), label: 'ดูคิว / แต้มของฉัน' }, 'paid');
  }
  return { ok: true, ticketId: Number(ticketId), total: order.total, loyalty, code: ticket?.code || null, number: ticket?.number || null };
}

/** Merge-pay: settle several pending orders in ONE cashier action / tender (รวมบิล). Each order
 *  keeps its own queue number — only the PAYMENT is combined. setOrderPaid is idempotent + already
 *  handles queue number / stock / loyalty per order, so this just loops it and collects results. */
export function payMulti(ticketIds, opts = {}) {
  const ids = [...new Set((ticketIds || []).map(Number).filter(Boolean))];
  const results = [];
  for (const id of ids) {
    try { results.push(setOrderPaid(id, opts)); }
    catch (e) { results.push({ ticketId: id, error: e.message }); }
  }
  const codes = results.filter((r) => r.code).map((r) => r.code);
  const total = results.reduce((s, r) => s + (r.total || 0), 0);
  return { ok: true, count: results.filter((r) => r.ok).length, codes, total, results };
}

/** แยกจ่ายตามเงิน: take a partial payment toward a bill. Accumulates orders.paid_amount; once it
 *  covers the net (total − discount), settle in full via setOrderPaid (issue queue number etc.).
 *  Returns the running paid + remaining so the cashier keeps collecting until the balance is 0. */
export function payPartial(ticketId, amount, opts = {}) {
  const { actorId = null, method: rawMethod = null, clientToken = null } = opts;
  const method = normalizeMethod(rawMethod);   // CASH-10
  const amt = Math.round((Number(amount) || 0) * 100) / 100;
  if (amt <= 0) throw new Error('bad_amount');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') return { ok: true, settled: true, alreadyPaid: true, remaining: 0 };
  if (order.payment_status === 'void') throw new Error('order_void');
  const net = Math.round(((order.total || 0) - (order.discount || 0)) * 100) / 100;
  // Leg + paid_amount move atomically. Record the tender leg FIRST: with a clientToken, a retried tap
  // (flaky wifi) inserts a duplicate token → recordPaymentLeg returns false → we return the current
  // state without re-accumulating (CASH-3: a double-tap used to settle the bill for half the money).
  return db.transaction(() => {
    // The leg records only the money the drawer KEEPS: on an overpaying final slice the change is
    // handed back, so cap the leg at the remaining balance (else cash is over by the change).
    const remaining = Math.round((net - (order.paid_amount || 0)) * 100) / 100;
    const applied = Math.min(amt, Math.max(0, remaining));
    const legWritten = recordPaymentLeg({ orderId: order.id, branchId: order.branch_id, method: method || 'cash', amount: applied, kind: 'payment', actorId, clientToken });
    if (clientToken && !legWritten) {
      const cur = db.prepare('SELECT paid_amount, payment_status FROM orders WHERE id=?').get(order.id);
      const settled = cur.payment_status === 'paid';
      return { ok: true, settled, duplicate: true, paid: cur.paid_amount || 0, remaining: settled ? 0 : Math.round((net - (cur.paid_amount || 0)) * 100) / 100 };
    }
    const newPaid = Math.round(((order.paid_amount || 0) + amt) * 100) / 100;
    if (newPaid >= net - 0.001) {                 // covered (1-satang slack) → settle fully
      db.prepare('UPDATE orders SET paid_amount=? WHERE id=?').run(net, order.id);
      const r = setOrderPaid(ticketId, { actorId, method, _skipLeg: true });   // leg already recorded above
      return { ok: true, settled: true, paid: net, remaining: 0, change: Math.round((newPaid - net) * 100) / 100, code: r.code || null, number: r.number || null };
    }
    db.prepare('UPDATE orders SET paid_amount=? WHERE id=?').run(newPaid, order.id);   // balance remains → stay unpaid
    logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'partial', amount: amt, actor: actorId, meta: { method: method || 'cash', paid: newPaid, net } });
    return { ok: true, settled: false, paid: newPaid, remaining: Math.round((net - newPaid) * 100) / 100 };
  })();
}

/** Customer attaches a payment slip (no SlipOK): stored for the cashier to eyeball, and the
 *  order is flagged 'claimed' so the cashier knows to verify + confirm. */
export function attachSlip(ticketId, imageData) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') return { ok: true, already: true };
  const sha = createHash('sha256').update(imageData || '').digest('hex');   // fingerprint → catch the SAME slip reused
  db.prepare(`INSERT INTO slips (order_id, ticket_id, image, sha) VALUES (?,?,?,?)
              ON CONFLICT(order_id) DO UPDATE SET image=excluded.image, sha=excluded.sha, at=datetime('now')`).run(order.id, Number(ticketId), imageData, sha);
  // NOT IN ('paid','void'): excluding only 'paid' let a customer's "I paid" claim resurrect an
  // order the cashier had already voided, putting a cancelled bill back on the pay-verification list.
  db.prepare(`UPDATE orders SET payment_status='claimed' WHERE id=? AND payment_status NOT IN ('paid','void')`).run(order.id);
  return { ok: true };
}
/** Preliminary (free) slip check for the cashier — this does NOT prove the slip is genuine (that
 *  needs SlipOK's QR-vs-bank check). It flags the SAME slip image reused on another order, and hands
 *  the cashier the expected amount + today's date to eyeball against the slip. */
export function slipPrelim(ticketId) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return null;
  const s = db.prepare('SELECT sha FROM slips WHERE order_id=?').get(order.id);
  let duplicate = null;
  if (s && s.sha) {
    const dup = db.prepare(
      `SELECT t.code, t.id FROM slips sl JOIN tickets t ON t.id=sl.ticket_id
        WHERE sl.sha=? AND sl.order_id<>? ORDER BY sl.at DESC LIMIT 1`
    ).get(s.sha, order.id);
    if (dup) duplicate = { code: dup.code, ticketId: dup.id };
  }
  const today = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
  return { expectedAmount: Math.max(0, order.total - (order.discount || 0)), today, duplicate };
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
  // NOT IN ('paid','void'): excluding only 'paid' let a customer's "I paid" claim resurrect an
  // order the cashier had already voided, putting a cancelled bill back on the pay-verification list.
  db.prepare(`UPDATE orders SET payment_status='claimed' WHERE id=? AND payment_status NOT IN ('paid','void')`).run(order.id);
  return { ok: true };
}

/** Apply a bill-level discount to a ticket's order. amount is clamped to [0, subtotal].
 *  Net due = total − discount. Recorded as a 'discount' sale_event. */
export function setOrderDiscount(ticketId, { amount, reason = null, actorId = null } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'void') throw new Error('order_void');
  // A discount AFTER payment silently erased revenue + expected cash (the money was already in the
  // drawer). Post-payment price changes must go through refund + re-ring. The UI hides the button
  // on a paid card, but a two-till stale-card race could still reach here (CASH-2). Reward/lucky/
  // birthday redemptions all guard `paid` before calling this, so they're unaffected.
  if (order.payment_status === 'paid') throw new Error('order_already_paid');
  let amt = Math.max(0, Number(amount) || 0);
  amt = Math.min(amt, order.total);
  amt = Math.round(amt * 100) / 100;
  const rsn = reason ? reason.toString().slice(0, 200) : null;
  db.prepare('UPDATE orders SET discount=?, discount_reason=? WHERE id=?').run(amt, rsn, order.id);
  logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'discount', amount: amt, actor: actorId, meta: { reason: rsn } });
  return { ok: true, ticketId: Number(ticketId), discount: amt, total: order.total, net: Math.round((order.total - amt) * 100) / 100 };
}

/** Redeem a stamp reward against a specific UNPAID LINE order: deduct the reward's stamps and
 *  apply a free-drink discount (cheapest drink in the cart, capped at the reward template's value)
 *  to that order. The order
 *  already carries the customer's line_user_id, so no QR/id handshake is needed at the counter —
 *  the cashier just taps "แลกฟรี" on the customer's order. One redemption per order. */
export function redeemRewardOnOrder(ticketId, rewardId = null, actorId = null) {
  const t = db.prepare('SELECT line_user_id, customer_key FROM tickets WHERE id=?').get(ticketId);
  const loyKey = t && (t.line_user_id || t.customer_key);
  if (!t || !loyKey) throw new Error('no_customer');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') throw new Error('order_already_paid');
  if (order.payment_status === 'void') throw new Error('order_void');
  if (db.prepare("SELECT 1 FROM loyalty_moves WHERE order_id=? AND kind='redeem'").get(order.id)) throw new Error('already_redeemed');
  const key = loyKey;
  const reward = rewardId
    ? db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(rewardId)
    : db.prepare('SELECT * FROM rewards WHERE active=1 ORDER BY cost_points, id LIMIT 1').get();
  if (!reward) throw new Error('reward_not_found');
  const bal = loyaltyBalance(key).points;
  if (bal < reward.cost_points) {
    // Under the conversion model a completed card is already a coupon (points spent) — so when the
    // cashier taps แลกฟรี on an order, fall through to the customer's live coupon if they hold one.
    const cc = customerCoupons(key)[0];
    if (cc) return redeemCustomerCoupon(ticketId, cc.id, actorId);
    throw new Error('insufficient_points');
  }
  const cheapest = db.prepare(
    `SELECT MIN(oi.price) p FROM order_items oi LEFT JOIN menu_items mi ON mi.name=oi.name
      WHERE oi.order_id=? AND COALESCE(mi.category,'drink')!='topping' AND oi.price>0`
  ).get(order.id)?.p;
  const room = Math.max(0, order.total - (order.discount || 0));
  const free = Math.round(Math.min(couponTemplate('reward').value, cheapest || room, room) * 100) / 100;
  if (free <= 0) throw new Error('nothing_to_discount');
  const reason = '🎁 แลกแต้ม: ' + reward.name;
  // Spending the stamps and applying the discount must be one unit — the discount used to run
  // AFTER the points transaction committed, so a failure there cost the customer their card.
  // The balance guard lives IN the UPDATE: the read above is not atomic, so two fast taps could
  // both pass it and drive the balance negative.
  let res;
  db.transaction(() => {
    const spent = db.prepare('UPDATE customers SET points = points - ? WHERE line_user_id=? AND points >= ?').run(reward.cost_points, key, reward.cost_points);
    if (!spent.changes) throw new Error('insufficient_points');
    db.prepare(`INSERT INTO loyalty_moves (customer_key, kind, points, order_id, note) VALUES (?, 'redeem', ?, ?, ?)`).run(key, -reward.cost_points, order.id, reason);
    res = setOrderDiscount(ticketId, { amount: (order.discount || 0) + free, reason, actorId });
  })();
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

/** Apply one of the customer's issued coupons (stamp-card conversion or birthday gift) to an
 *  UNPAID order: free-drink discount = min(coupon cap, cheapest drink, remaining bill). Marks the
 *  coupon used (re-opened automatically if the order is later voided). Points are NOT touched —
 *  they were already spent when the card converted. */
export function redeemCustomerCoupon(ticketId, ccId, actorId = null) {
  const t = db.prepare('SELECT line_user_id, customer_key FROM tickets WHERE id=?').get(ticketId);
  const key = t && (t.line_user_id || t.customer_key);
  if (!key) throw new Error('no_customer');
  const cc = db.prepare('SELECT * FROM customer_coupons WHERE id=?').get(ccId);
  if (!cc || cc.customer_key !== key) throw new Error('coupon_not_found');
  if (cc.state === 'cancelled') throw new Error('coupon_cancelled');
  if (cc.used_at) throw new Error('coupon_used');
  if (db.prepare("SELECT date('now','+7 hours') > ? x").get(cc.expires_at).x === 1) throw new Error('coupon_expired');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status === 'paid') throw new Error('order_already_paid');
  if (order.payment_status === 'void') throw new Error('order_void');
  const cheapest = db.prepare(
    `SELECT MIN(oi.price) p FROM order_items oi LEFT JOIN menu_items mi ON mi.name=oi.name
      WHERE oi.order_id=? AND COALESCE(mi.category,'drink')!='topping' AND oi.price>0`
  ).get(order.id)?.p;
  const room = Math.max(0, order.total - (order.discount || 0));
  const free = Math.round(Math.min(cc.free_cap, cheapest || room, room) * 100) / 100;
  if (free <= 0) throw new Error('nothing_to_discount');
  const reason = (cc.kind === 'birthday' ? '🎂 คูปองวันเกิด: ' : '🎁 คูปองสะสมครบ: ') + cc.label;
  // Burn the wallet coupon ATOMICALLY: the used_at check above is a read, so two fast taps could
  // both reach here. Guarding the UPDATE means exactly one of them wins and the other is told it's
  // already used, instead of the discount being applied twice.
  // used_value = what the shop actually gave away, not the coupon's ceiling — the report is only
  // honest if it adds up real discounts.
  // Burn and discount are ONE transaction: a failure between them used to leave the customer with
  // no coupon and no discount — they paid full price for something they had already earned.
  let res;
  db.transaction(() => {
    const burned = db.prepare(`UPDATE customer_coupons SET used_at=datetime('now'), used_order_id=?, state='redeemed', used_value=? WHERE id=? AND used_at IS NULL AND state != 'cancelled'`).run(order.id, free, cc.id);
    if (!burned.changes) throw new Error('coupon_used');
    res = setOrderDiscount(ticketId, { amount: (order.discount || 0) + free, reason, actorId });
  })();
  if (t.line_user_id) pushQueue(t.line_user_id, `${cc.kind === 'birthday' ? '🎂' : '🎁'} ใช้คูปอง "${cc.label}" แล้ว! ลด ฿${free}\nขอบคุณที่อุดหนุนค่ะ 💛`, null);
  let autoPaid = false;
  if (res.net <= 0) {
    try { setOrderPaid(ticketId, { actorId, method: 'reward', skipLoyalty: true }); autoPaid = true; }
    catch { /* leave it unpaid if completion fails */ }
  }
  return { ok: true, redeemed: cc.label, couponId: cc.id, freeAmount: free, net: autoPaid ? 0 : res.net, autoPaid };
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
    const items = db.prepare('SELECT name, qty, menu_item_id FROM order_items WHERE order_id=?').all(order.id);
    const code = db.prepare('SELECT code FROM tickets WHERE id=?').get(order.ticket_id)?.code || ('#' + order.id);
    for (const it of items) {
      let miId = it.menu_item_id;   // rename-proof, same as the deduction side
      if (!miId) {
        const base = String(it.name).split(' · ')[0];
        miId = db.prepare('SELECT id FROM menu_items WHERE name=? LIMIT 1').get(base)?.id;
      }
      if (!miId) continue;
      for (const r of db.prepare('SELECT ingredient_id, qty FROM recipes WHERE menu_item_id=?').all(miId)) {
        const back = (Number(r.qty) || 0) * (Number(it.qty) || 1);
        if (back > 0) try { recordStockMove(r.ingredient_id, { kind: 'return', qty: back, note: 'คืนสต๊อก (ยกเลิก) ' + code }); } catch { /* never block a void */ }
      }
    }
  } catch { /* stock return must never break a void */ }
}
/** ของเสีย + ทำใหม่ on a PAID order (CASH-4). The drink was made, spoiled, and is being remade —
 *  so the SALE stands (revenue kept, drawer untouched) and the wasted first attempt is booked as a
 *  waste cost: its recipe ingredients are posted as 'waste' stock moves (a second consumption on top
 *  of the sale's). byShop only flavours the reason (ความผิดร้าน vs ลูกค้า) — the money is identical
 *  either way. Does NOT cancel the ticket. Returns the wasted cup count + ingredient cost. */
export function recordWaste(ticketId, { reason = null, byShop = false, actorId = null } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) throw new Error('order_not_found');
  if (order.payment_status !== 'paid') throw new Error('order_not_paid');   // waste-of-unpaid = cancel-with-waste path
  const code = db.prepare('SELECT code FROM tickets WHERE id=?').get(order.ticket_id)?.code || ('#' + order.id);
  const items = db.prepare('SELECT name, qty, menu_item_id FROM order_items WHERE order_id=?').all(order.id);
  let cups = 0, cost = 0;
  const rsn = (byShop ? 'ของเสีย (ความผิดร้าน)' : 'ของเสีย (ไม่ใช่ความผิดร้าน)') + (reason ? ` — ${String(reason).slice(0, 120)}` : '');
  db.transaction(() => {
    for (const it of items) {
      cups += Number(it.qty) || 1;
      let miId = it.menu_item_id;
      if (!miId) { const base = String(it.name).split(' · ')[0]; miId = db.prepare('SELECT id FROM menu_items WHERE name=? LIMIT 1').get(base)?.id; }
      if (!miId) continue;
      for (const r of db.prepare('SELECT ingredient_id, qty FROM recipes WHERE menu_item_id=?').all(miId)) {
        const q = (Number(r.qty) || 0) * (Number(it.qty) || 1);
        if (q > 0) try {
          const ing = db.prepare('SELECT avg_cost FROM ingredients WHERE id=?').get(r.ingredient_id);
          cost += q * (Number(ing?.avg_cost) || 0);
          recordStockMove(r.ingredient_id, { kind: 'waste', qty: q, note: 'ของเสีย/ทำใหม่ ' + code, actorId });
        } catch { /* a missing ingredient must never block booking the waste */ }
      }
    }
    logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'waste_remake', amount: order.total, actor: actorId, meta: { reason: rsn, byShop, cups } });
  })();
  return { ok: true, cups, cost: Math.round(cost * 100) / 100, byShop, reason: rsn };
}

/** Undo an order's loyalty effects when it's voided: returns redeemed stamps to the customer
 *  and removes any stamps it earned, keeping the ledger consistent. Returns net points returned
 *  to the ticket's own customer (positive = points given back). */
function reverseLoyaltyForOrder(orderId, ownerKey) {
  // A coupon spent on this order comes back to the customer when the order is voided.
  try { db.prepare(`UPDATE customer_coupons SET used_at=NULL, used_order_id=NULL, state='claimed' WHERE used_order_id=?`).run(orderId); } catch { /* table may predate feature */ }
  // CODE coupons too: the redemption never used to be handed back, so every voided order
  // permanently shrank the coupon's quota AND burned the customer's per-person allowance.
  // Deleting the coupon_uses row is what restores the per-customer limit — validateCoupon counts rows.
  try {
    for (const u of db.prepare('SELECT id, coupon_id FROM coupon_uses WHERE order_id=?').all(orderId)) {
      db.prepare('UPDATE coupons SET used_count = MAX(0, used_count - 1) WHERE id=?').run(u.coupon_id);
      db.prepare('DELETE FROM coupon_uses WHERE id=?').run(u.id);
    }
  } catch { /* table may predate feature */ }
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
  const { actorId = null, reason = null, kind: kindOpt = null, restock = false, refundMethod: rawRefundMethod = null } = opts;
  const refundMethod = normalizeMethod(rawRefundMethod);   // CASH-10
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  const wasPaid = !!(order && order.payment_status === 'paid');   // paid => stock was deducted
  const kind = wasPaid ? 'refund' : (kindOpt === 'waste' ? 'waste' : 'void');
  // Void/refund: mark the order void (even if it was already paid -> a refund) so it
  // drops out of the report and its revenue is deducted from sales.
  // Scoped to the resolved order.id, not the ticket: every other path reads "the latest order on
  // this ticket", so voiding by ticket_id silently killed earlier orders too. The 'void' guard
  // makes a second cancel a no-op instead of overwriting voided_at/voided_by and logging the
  // refund amount twice.
  // Void + restock + loyalty reversal + ticket close are one refund: a throw partway through must
  // not leave the order voided with the stamps still spent (or the stock still deducted).
  // The LINE push and notification sweep stay outside — network work never belongs in a transaction.
  const pointsReturned = db.transaction(() => {
    const voided = order
      ? db.prepare(`UPDATE orders SET payment_status='void', void_kind=?, void_reason=?, voided_at=datetime('now'), voided_by=? WHERE id=? AND payment_status<>'void'`)
          .run(kind, reason, actorId, order.id)
      : { changes: 0 };
    const alreadyVoid = !!order && !voided.changes;
    // If the drink was never made (restock reason) AND its stock had been deducted (paid), put
    // the ingredients back. A "made then discarded" reason leaves stock deducted (it was a waste).
    if (order && wasPaid && restock && !alreadyVoid) returnStockForOrder(order);
    // Undo loyalty: return any redeemed stamps + remove any stamps earned on this order — BUT only
    // if the drink wasn't already served. Once served, the product cost is incurred and the free
    // drink was handed over, so points are never returned (owner rule).
    const pts = (order && t.status !== 'served' && !alreadyVoid) ? reverseLoyaltyForOrder(order.id, t.line_user_id) : 0;
    // Refund tender leg: the money left the drawer in refundMethod (the cashier says HOW it was
    // returned — a K PLUS sale can be refunded in cash). Defaults to the original method. This is
    // what makes a cash refund of a non-cash sale reduce the drawer (CASH-5).
    if (order && wasPaid && kind === 'refund' && !alreadyVoid) {
      recordPaymentLeg({ orderId: order.id, branchId: order.branch_id, method: refundMethod || order.payment_method || 'cash', amount: order.total - (order.discount || 0), kind: 'refund', actorId });
    }
    if (order && !alreadyVoid) logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: kind, amount: order.total, actor: actorId, meta: { reason, restock, pointsReturned: pts, refundMethod: (kind === 'refund' ? (refundMethod || order.payment_method || 'cash') : undefined) } });
    db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(ticketId);
    return pts;
  })();
  if (t.line_user_id) {
    const byRequest = !!t.cancel_requested;   // the customer asked → confirm we did it; else the shop cancelled
    const safeReason = !byRequest ? safeCancelReason(reason || '') : null;   // same whitelist the web ticket screen uses
    pushQueue(t.line_user_id,
      (byRequest
        ? `✅ ยกเลิกออเดอร์ ${t.code} ให้เรียบร้อยแล้วค่ะ ตามที่คุณขอ\n`
        : `❌ ออเดอร์ ${t.code} ถูกยกเลิกโดยร้านค่ะ\n`) +
      (safeReason ? `${safeReason}\n` : '') +
      (pointsReturned > 0 ? `🔄 คืน ${pointsReturned} ดวงเข้าบัญชีของคุณแล้ว\n` : '') +
      `สั่งใหม่ได้ตลอดเลยนะคะ ขอบคุณค่ะ 🙂`, null);
  }
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return { ok: true };
}

/** กู้คืนออเดอร์: revive a cancelled UNPAID order (typically auto-voided by the payment timeout)
 *  when the customer finally shows up — back into the queue, collect payment, serve as normal.
 *  Refunds are NOT recoverable (money already moved; re-key a fresh order instead). */
export function recoverOrderTicket(ticketId, opts = {}) {
  const { actorId = null } = opts;
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  if (t.status !== 'cancelled') throw new Error('not_cancelled');
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order || order.payment_status !== 'void') throw new Error('order_not_void');
  if (order.void_kind === 'refund') throw new Error('refund_not_recoverable');
  // A numbered ticket rejoins the queue as waiting; a never-numbered one goes back to pending
  // (it gets its number at payment, same as any pay-first order).
  const backTo = t.code ? 'waiting' : 'pending';
  db.transaction(() => {
    db.prepare(`UPDATE orders SET payment_status='unpaid', void_kind=NULL, void_reason=NULL, voided_at=NULL, voided_by=NULL WHERE id=?`).run(order.id);
    // created_at is refreshed so the stale-pending sweep doesn't instantly re-void the ticket
    // (its original created_at is already past the timeout) — and the customer re-queues from now.
    db.prepare(`UPDATE tickets SET status=?, closed_at=NULL, cancel_requested=0, created_at=datetime('now') WHERE id=?`).run(backTo, ticketId);
    // The void handed the coupon back; the recovered order still carries its discount, so
    // re-consume the code coupon (best-effort) or the discount would be double-spendable.
    const cm = /คูปอง (\S+)/.exec(order.discount_reason || '');
    if (cm && !db.prepare('SELECT 1 FROM coupon_uses WHERE order_id=?').get(order.id)) {
      const cp = db.prepare('SELECT id, usage_limit, used_count FROM coupons WHERE UPPER(code)=UPPER(?)').get(cm[1]);
      if (cp && db.prepare('UPDATE coupons SET used_count=used_count+1 WHERE id=? AND (usage_limit<=0 OR used_count<usage_limit)').run(cp.id).changes) {
        db.prepare('INSERT INTO coupon_uses (coupon_id, order_id, customer_key, discount) VALUES (?,?,?,?)')
          .run(cp.id, order.id, t.line_user_id || t.customer_key || null, order.discount || 0);
      }
    }
    logSaleEvent({ branchId: order.branch_id, ticketId: Number(ticketId), orderId: order.id, type: 'recover', amount: order.total, actor: actorId, meta: { was: order.void_reason || null } });
  })();
  if (t.line_user_id) {
    pushQueue(t.line_user_id, `✅ ออเดอร์ ${t.code || ''} ของคุณกลับเข้าคิวแล้วค่ะ\nชำระเงินที่หน้าร้านได้เลยนะคะ 🙂`, null);
  }
  return { ok: true, status: backTo, code: t.code || null };
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
  // order matters for FKs: order_items → orders → tickets; purchase_order_lines → purchase_orders;
  // the rest are independent. customer_coupons/coupon_uses/cash_moves/push_log ride along: a reset
  // that deleted customers but left their wallet coupons behind kept those coupons REDEEMABLE with
  // no owner (audit #8). stock_moves + purchase_orders ride along too (ACC-F9): leaving the stock
  // LEDGER behind while deleting the sales it belonged to haunted every day's COGS forever with
  // "cost of goods" that had no revenue. We clear the transactional ledger but KEEP the current
  // on-hand (ingredients.stock_qty) and weighted-avg cost — physical stock + costing are config-like
  // and survive the reset, so COGS simply starts clean from the current inventory.
  const tables = ['order_items', 'orders', 'tickets', 'order_payments', 'sale_events', 'loyalty_moves', 'customer_coupons', 'coupon_uses', 'cash_moves', 'push_log', 'cash_sessions', 'daily_stats', 'sales_history', 'customers', 'slips', 'purchase_order_lines', 'purchase_orders', 'stock_moves'];
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
      WHERE t.status IN ('pending','waiting') AND o.payment_status NOT IN ('paid','void')
        AND t.created_at <= datetime('now', ?)`
  ).all(`-${mins} minutes`);
  if (!rows.length) return { voided: 0, zones: [] };
  const zones = new Set();
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE orders SET payment_status='void', void_kind='void', void_reason='auto: หมดเวลาชำระ', voided_at=datetime('now'), voided_by=? WHERE id=?`).run(actorId, r.order_id);
      db.prepare(`UPDATE tickets SET status='cancelled', closed_at=datetime('now') WHERE id=?`).run(r.id);
      // Same reversal as a manual void: hand back the wallet coupon and the code-coupon
      // quota/allowance — a timed-out order used to burn them permanently.
      try { reverseLoyaltyForOrder(r.order_id, r.line_user_id); } catch { /* never break the sweep */ }
      logSaleEvent({ branchId: r.branch_id, ticketId: r.id, orderId: r.order_id, type: 'void', amount: r.total, actor: actorId, meta: { reason: 'auto_timeout' } });
      zones.add(r.zone_id);
    }
  })();
  // Best-effort: tell each customer their unpaid order expired (graceful no-op without a token).
  for (const r of rows) {
    if (r.line_user_id) pushQueue(r.line_user_id, '⌛ ออเดอร์ของคุณหมดเวลาชำระและถูกยกเลิกอัตโนมัติ\nยังต้องการอยู่ไหมคะ? แจ้งพนักงานที่ร้านให้กู้คืนออเดอร์เดิมได้เลย หรือสั่งใหม่ได้ตลอดค่ะ 🙂', null);
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
  // แยกตามรายการ: which grouped lines were already settled (display "✓ ชำระแล้ว"). paid_lines is a JSON
  // array of line indices; paid_amount stays the money source-of-truth (settles the order when ≥ net).
  let paidLines = [];
  try { paidLines = order.paid_lines ? JSON.parse(order.paid_lines) : []; } catch { paidLines = []; }
  lines.forEach((l, i) => { l.paid = paidLines.includes(i); });
  // discount_reason was missing from this hand-built object, so every reason the code carefully sets
  // (คูปอง / วันเกิด / เลขนำโชค) reached the customer's ticket as null. The DB and the audit log were
  // always right — only the label the customer reads was being dropped here.
  return { total: order.total, discount: order.discount || 0, discount_reason: order.discount_reason || null, paid_amount: order.paid_amount || 0, paid_lines: paidLines, items: rows, lines, payment_status: order.payment_status || 'unpaid', method: order.payment_method || null, source: order.source || 'cashier', refund_requested: order.refund_requested || 0, refund_note: order.refund_note || null, created_at: order.created_at, paid_at: order.paid_at };
}

/** Server-side subtotal of one grouped order line (drink + its toppings) — the authoritative amount
 *  for แยกตามรายการ (never trust a client-sent amount for money). */
function lineSubtotal(l) {
  return Math.round((((l.price || 0) * (l.qty || 1)) + (l.toppings || []).reduce((s, tp) => s + (tp.price || 0) * (tp.qty || 1), 0)) * 100) / 100;
}

/** แยกตามรายการ: settle specific order lines. Marks them in orders.paid_lines AND adds their
 *  authoritative subtotal to paid_amount; when paid_amount covers the net, settles + issues the queue
 *  number (same as payPartial). Already-paid lines are ignored (idempotent). */
export function payItems(ticketId, lineIdxs, opts = {}) {
  const { actorId = null, method = null } = opts;
  const o = orderForTicket(ticketId);
  if (!o) throw new Error('order_not_found');
  if (o.payment_status === 'paid') return { ok: true, settled: true, alreadyPaid: true, remaining: 0, paidLines: o.paid_lines };
  if (o.payment_status === 'void') throw new Error('order_void');
  const already = new Set(o.paid_lines || []);
  const fresh = [...new Set((Array.isArray(lineIdxs) ? lineIdxs : []).map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < o.lines.length && !already.has(i));
  if (!fresh.length) throw new Error('no_items');
  const amt = Math.round(fresh.reduce((s, i) => s + lineSubtotal(o.lines[i]), 0) * 100) / 100;
  const order = db.prepare('SELECT id FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  const merged = [...already, ...fresh].sort((a, b) => a - b);
  // marking the lines paid and taking the money must be atomic, or a throw inside payPartial
  // would leave the lines flagged as settled with no payment recorded against them
  const r = db.transaction(() => {
    db.prepare('UPDATE orders SET paid_lines=? WHERE id=?').run(JSON.stringify(merged), order.id);
    return payPartial(ticketId, amt, { actorId, method });   // accumulates paid_amount + settles when covered
  })();
  return { ...r, paidLines: merged, paidNow: amt };
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
    `SELECT id, code, number, party_size, customer_name, notified_soon, making_at, cancel_requested FROM tickets
     WHERE zone_id=? AND status='waiting' ORDER BY number ASC`
  ).all(zoneId);
  // All currently-called (called but not yet served) tickets, newest first. The cashier UI shows the
  // 5 most recent by default with a "แสดงทั้งหมด" toggle for the rest. Capped at 100 as a sane bound
  // ('called' is transient — it clears on serve/no-show — so this is effectively unbounded in practice).
  const recentCalled = db.prepare(
    `SELECT id, code, number, party_size, customer_name, called_at FROM tickets
     WHERE zone_id=? AND status='called' ORDER BY called_at DESC LIMIT 100`
  ).all(zoneId);
  // Pay-first: orders awaiting payment (no queue number yet). The cashier confirms payment
  // here, which issues the number and moves them into `waiting`.
  const pending = db.prepare(
    `SELECT id, code, number, party_size, customer_name, created_at, making_at, cancel_requested FROM tickets
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
      t.order_paid = Math.round((o.paid_amount || 0) * 100) / 100; // partial payments so far (แยกตามเงิน)
      t.order_summary = o.items.map((i) => `${i.qty}× ${i.name}`).join(', ');
      t.order_lines = o.lines;               // grouped: drink + its toppings (dash sub-lines)
      t.payment_status = o.payment_status;   // 'unpaid' | 'paid' | 'void'
      t.order_source = o.source;             // 'cashier' | 'customer'
      t.order_created_at = o.created_at;     // when the order was placed (UTC)
      t.order_paid_at = o.paid_at;           // when it was paid (UTC), if paid
    }
    // Cashier-only: show the attached customer (phone) so staff always know an order is tagged — even
    // with loyalty OFF (CRM). When loyalty is ON, also attach the stamp balance for on-the-spot redeem.
    if (reveal) {
      const r = db.prepare('SELECT line_user_id, customer_key FROM tickets WHERE id=?').get(t.id);
      if (r && (r.customer_key || '').startsWith('tel:')) t.cust_phone = r.customer_key.slice(4);
      // Auto-recognition: if the order is tied to a KNOWN customer (LINE id or phone), attach a mini
      // profile so the card greets them ("มา N ครั้ง · ชอบ X") with no lookup. null for new customers.
      const ck = r && (r.line_user_id || r.customer_key);
      if (ck) { const m = customerMini(ck); if (m) t.cust = m; }
      if (loyaltyEnabled()) {
        const li = r && (r.line_user_id || r.customer_key);
        if (li) { const b = loyaltyBalance(li); t.loy_points = b.points; t.loy_tier = b.tier ? b.tier.emoji : null; t.loy_phone = (r.customer_key || '').startsWith('tel:') ? r.customer_key.slice(4) : null; }
      }
    }
    return t;
  };
  waiting.forEach(attach); recentCalled.forEach(attach); pending.forEach(attach);
  // Only the cashier (reveal) needs the awaiting-payment list; public/display omit it.
  return { zone, waiting, recentCalled, waitingCount: waiting.length, pending: reveal ? pending : [] };
}

// Customer-safe cancellation reason: whitelist-maps an internal void_reason to wording that's
// safe to show/send to the customer. Internal notes like "ทำพลาด"/"ลูกค้าไม่พอใจ" never leave
// the building. Shared by ticketView() (web) and cancelOrderTicket()'s LINE push, so both
// channels always say the same thing.
function safeCancelReason(raw) {
  const MAP = {
    'ของหมด/ทำไม่ได้': 'ขออภัยค่ะ เมนูนี้ของหมดพอดี 🙏',
    'ลูกค้าไม่มารับ': 'ออเดอร์ถูกยกเลิกเนื่องจากไม่มีผู้มารับค่ะ',
  };
  return MAP[raw] || (raw && raw.startsWith('auto:') ? 'ออเดอร์หมดเวลาชำระและถูกยกเลิกอัตโนมัติค่ะ' : null);
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
    // customer_key filter matters: on a referred friend's first order, awardPoints also logs the
    // REFERRER's bonus row under the same order_id — without the filter that row inflated `bonus`
    // (wrong "+N ดวงต้อนรับ") and corrupted the rewardJustReady boundary math below.
    const earns = db.prepare("SELECT id, points, note FROM loyalty_moves WHERE order_id=? AND kind='earn' AND customer_key=?").all(ord.id, t.line_user_id);
    if (earns.length) {
      const awarded = earns.filter((e) => !e.note).reduce((s, e) => s + e.points, 0);
      // "Welcome" means the first-order note specifically — birthday/referral bonuses are ALSO noted
      // earns, and treating any note as "first order" showed ยินดีต้อนรับสมาชิกใหม่ to long-time
      // customers ordering on their birthday (and suppressed the reward celebration via the else-if).
      const bonus = earns.filter((e) => e.note === WELCOME_NOTE).reduce((s, e) => s + e.points, 0);
      const earnedThis = earns.reduce((s, e) => s + e.points, 0);
      const bal = loyaltyBalance(t.line_user_id).points;
      const per = getStampsPerReward();
      // Boundary math on the balance AS OF this order's earns (current balance minus every move
      // logged after them) — the live balance made the flag unstable: a counter redeem between
      // paying and the LIFF's next poll silently swallowed the celebration.
      const maxEarnId = Math.max(...earns.map((e) => e.id));
      const later = db.prepare('SELECT COALESCE(SUM(points),0) s FROM loyalty_moves WHERE customer_key=? AND id>?').get(t.line_user_id, maxEarnId).s;
      const balAtEarn = bal - later;
      // Did THIS order complete a fresh stamp card (cross a multiple of `per`)? If so — and a real reward
      // is actually redeemable — flag it so the LIFF fires the reward-celebration moment. The client shows
      // it once per ticket; the first-order welcome "wow" takes precedence when both would apply.
      const rewardJustReady = earnedThis > 0 && per > 0
        && Math.floor(balAtEarn / per) > Math.floor((balAtEarn - earnedThis) / per)
        && listRewards(false).length > 0;
      loyalty = { awarded, bonus, firstOrder: bonus > 0, balance: bal, per, rewardJustReady };
    }
  }
  // Customer-safe cancellation reason: only for SHOP-initiated cancels (customer-requested ones
  // are already covered by cancelRequested), and only a whitelist so internal void notes such as
  // "ทำพลาด" / "ลูกค้าไม่พอใจ" never leave the building.
  let cancelReason = null;
  if (t.status === 'cancelled' && !t.cancel_requested) {
    const vr = db.prepare('SELECT void_reason FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(t.id);
    const raw = (vr && vr.void_reason) || '';
    cancelReason = safeCancelReason(raw);
  }
  return {
    id: t.id, code: t.code, number: t.number, status: t.status, party_size: t.party_size, rating: t.rating,
    // Queue-first cancel gating for the LIFF: customer may self-cancel only while unpaid & not being made.
    canCancel: ['pending', 'waiting'].includes(t.status) && !t.making_at && !(o && o.payment_status === 'paid'),
    cancelRequested: !!t.cancel_requested, cancelReason, making: !!t.making_at,
    zone: zone.name, ahead: t.status === 'waiting' ? aheadCount(t) : 0,
    last_called: zone.last_called ? `${zone.prefix}${pad(zone.last_called)}` : null,
    order: o ? { total: o.total, discount: o.discount, discount_reason: o.discount_reason || null, items: o.items, lines: o.lines, paid: o.payment_status === 'paid', status: o.payment_status, method: o.method, created_at: o.created_at, paid_at: o.paid_at, refund_requested: o.refund_requested || 0 } : null,
    loyalty,
    // Lucky-number prize. Only present on a winning ticket; the LIFF shows the congratulations
    // sheet while state is 'won' and the order is still unpaid (a paid order can't be discounted).
    lucky: t.lucky_state ? { state: t.lucky_state, value: t.lucky_value || 0, number: getLuckyNumber() } : null,
    // PAY-H2: the REAL auto-void moment (ticket created_at + pending:void_min), as epoch ms, so the
    // LIFF's QR countdown reflects true time left even after a reload/app-switch — not a fresh 30:00
    // that lies. Only while the order is still unpaid & auto-void is armed. sweepStalePending keys off
    // t.created_at (stored UTC), so we parse it as UTC here.
    payDeadline: (['pending', 'waiting'].includes(t.status) && o && o.payment_status !== 'paid'
                  && getPendingVoidMinutes() > 0 && t.created_at)
      ? Date.parse(String(t.created_at).replace(' ', 'T') + 'Z') + getPendingVoidMinutes() * 60000
      : null,
  };
}

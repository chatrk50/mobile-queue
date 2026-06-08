import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { db, getSetting } from './db.js';
import * as Q from './queue.js';
import { verifyPin, signSession, verifySession, parseCookies } from './auth.js';
import { subscribe, emit } from './events.js';
import { LINE_ENABLED, lineMiddleware, replyText } from './line.js';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true); // Render is behind a proxy — needed for a real req.ip
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CASHIER_PIN = process.env.CASHIER_PIN || '1234';
const THRESHOLD = Number(process.env.NOTIFY_THRESHOLD || 2);
const WAIT_PER_GROUP = Number(process.env.WAIT_PER_GROUP_MIN || 4); // est. minutes per group ahead
const LIFF_ID = process.env.LIFF_ID || '';
const ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL || '';
// Let customers build an order themselves in the LINE app (pay at counter). On by default.
const SELF_ORDER = String(process.env.SELF_ORDER ?? '1') !== '0';
// Merchant PromptPay id (phone / national id / e-wallet) for a dynamic amount QR; off if empty.
const PROMPTPAY_ID = (process.env.PROMPTPAY_ID || '').trim();
// Static merchant QR (e.g. a KShop / Thai-QR poster) — no amount, customer types it.
// Auto-on if you commit public/assets/promptpay.png; or set PROMPTPAY_STATIC to a custom URL.
const ppStaticEnv = (process.env.PROMPTPAY_STATIC || '').trim();
const PROMPTPAY_STATIC_URL = ppStaticEnv.startsWith('/') ? ppStaticEnv
  : ((ppStaticEnv || existsSync(join(__dirname, '..', 'public', 'assets', 'promptpay.png'))) ? '/assets/promptpay.png' : '');
// SlipOK automatic slip verification (https://slipok.com). Set both env vars to enable.
const SLIPOK_API_KEY = (process.env.SLIPOK_API_KEY || '').trim();
const SLIPOK_BRANCH_ID = (process.env.SLIPOK_BRANCH_ID || '').trim();
const SLIPOK_ON = Boolean(SLIPOK_API_KEY && SLIPOK_BRANCH_ID);
// Master switch for ONLINE payment (PromptPay QR + slip verify). OFF by default ->
// customers see "pay at counter" only. Flip PAY_ONLINE=1 in Render to re-enable later.
const PAY_ONLINE = String(process.env.PAY_ONLINE ?? '0') === '1';

// ---- LINE webhook ----
// line.middleware() reads the raw body, validates the x-line-signature, and
// populates req.body.events itself. Do NOT add express.json() here: a second
// body parser on the already-consumed stream throws -> 500 on LINE's Verify.
app.post('/line/webhook', lineMiddleware, async (req, res) => {
  const events = req.body?.events || [];
  for (const ev of events) {
    if (ev.type === 'follow') {
      await replyText(ev.replyToken,
        'ขอบคุณที่เพิ่มเพื่อนค่ะ! สแกน QR ที่ร้านเพื่อรับหมายเลขคิวได้เลย');
    }
  }
  res.sendStatus(200);
});

app.use(express.json({ limit: '1mb' })); // room for uploaded menu photos (base64 data URLs)

// ---- Staff session: a valid signed 'sess' cookie attaches req.staff (Phase 1). This
// runs before routes; legacy x-cashier-pin auth is untouched and still works. ----
app.use((req, res, next) => {
  try {
    const tok = parseCookies(req).sess;
    const p = tok ? verifySession(tok) : null;
    if (p && p.staffId) {
      const s = db.prepare('SELECT id, name, role, tenant_id, active FROM staff WHERE id=?').get(p.staffId);
      if (s && s.active) req.staff = { id: s.id, name: s.name, role: s.role, tenantId: s.tenant_id, branchIds: p.branchIds || [] };
    }
  } catch { /* ignore bad cookie */ }
  next();
});

// ---- PIN brute-force protection: lock an IP after repeated wrong PINs ----
const PIN_MAX_FAILS = 8, PIN_LOCK_MS = 10 * 60 * 1000;
const pinFails = new Map(); // ip -> { count, until }
const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
function pinLocked(ip) { const a = pinFails.get(ip); return !!(a && a.until > Date.now()); }
function countPinFail(ip) {
  const a = pinFails.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= PIN_MAX_FAILS) { a.until = Date.now() + PIN_LOCK_MS; a.count = 0; }
  pinFails.set(ip, a);
}
// A logged-in staff session counts as having the cashier PIN, so every existing
// PIN-gated route accepts session auth without changing each call site.
const pinPresent = (req) => req.get('x-cashier-pin') || req.query.pin || req.body?.pin || (req.staff ? CASHIER_PIN : null);
// Silent check (no fail-counting) — used to decide whether to reveal names.
const pinValueOK = (req) => pinPresent(req) === CASHIER_PIN;
// Block PIN-bearing requests from a locked IP before they hit any handler.
app.use((req, res, next) => {
  if (pinPresent(req) && pinLocked(ipOf(req))) return res.status(429).json({ error: 'too_many_attempts' });
  next();
});
app.use(express.static(join(__dirname, '..', 'public')));

// Authoritative check for protected actions — counts wrong PINs toward a lockout.
const pinOK = (req) => {
  const present = pinPresent(req), ok = present === CASHIER_PIN, ip = ipOf(req);
  if (ok) { pinFails.delete(ip); }
  else if (present) {
    const a = pinFails.get(ip) || { count: 0, until: 0 };
    a.count++;
    if (a.count >= PIN_MAX_FAILS) { a.until = Date.now() + PIN_LOCK_MS; a.count = 0; }
    pinFails.set(ip, a);
  }
  return ok;
};

// ---------- Public config (for frontends) ----------
app.get('/api/config', (req, res) => {
  res.json({ liffId: LIFF_ID, lineEnabled: LINE_ENABLED, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL, addFriendUrl: ADD_FRIEND_URL, minutesPerGroup: WAIT_PER_GROUP, selfOrder: SELF_ORDER, promptPay: PAY_ONLINE && Boolean(PROMPTPAY_ID || PROMPTPAY_STATIC_URL), promptPayStatic: PAY_ONLINE ? (PROMPTPAY_STATIC_URL || null) : null, slipVerify: PAY_ONLINE && SLIPOK_ON });
});

// ---------- Cashier login check (validates the PIN, no side effects) ----------
app.post('/api/auth', (req, res) => {
  res.json({ ok: pinOK(req) });
});

// ---------- Staff auth & roles (Phase 1) ----------
// The legacy admin PIN supplied DIRECTLY (header/query/body) — NOT via a session.
// (pinValueOK is true for any logged-in staff, so it must not gate owner actions.)
const legacyAdminPin = (req) => (req.get('x-cashier-pin') || req.query.pin || req.body?.pin) === CASHIER_PIN;
// Owner-level access = a logged-in OWNER session OR the legacy admin CASHIER_PIN.
const ownerOK = (req) => req.staff?.role === 'owner' || legacyAdminPin(req);
// Manager-level = owner/manager session OR legacy admin PIN (reports, finance).
const managerOK = (req) => ['owner', 'manager'].includes(req.staff?.role) || legacyAdminPin(req);
const SESSION_HOURS = 12;

// Staff PIN login -> signed httpOnly session cookie identifying who is at the till.
app.post('/api/staff/login', (req, res) => {
  const ip = ipOf(req);
  if (pinLocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const pin = (req.body?.pin || '').toString();
  if (!pin) return res.status(400).json({ error: 'pin_required' });
  const staff = db.prepare('SELECT * FROM staff WHERE active=1').all().find((s) => verifyPin(pin, s.pin_hash));
  if (!staff) { countPinFail(ip); return res.status(401).json({ error: 'bad_pin' }); }
  pinFails.delete(ip);
  const branchIds = staff.role === 'owner' ? []
    : db.prepare('SELECT branch_id FROM staff_branches WHERE staff_id=?').all(staff.id).map((r) => r.branch_id);
  const token = signSession({ staffId: staff.id, role: staff.role, tenantId: staff.tenant_id, branchIds, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.setHeader('Set-Cookie', `sess=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`);
  res.json({ ok: true, staff: { id: staff.id, name: staff.name, role: staff.role } });
});
app.post('/api/staff/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sess=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});
// Who am I (frontend reads this to show the logged-in staff + role).
app.get('/api/staff/me', (req, res) => {
  res.json({ staff: req.staff || null, legacyAdmin: pinValueOK(req) });
});
// Owner-only staff management.
app.get('/api/staff', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.listStaff());
});
app.post('/api/staff', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.createStaff(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/staff/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateStaff(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/staff/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.deactivateStaff(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Menu (public read; management is PIN-protected below) ----------
app.get('/api/menu', (req, res) => res.json(Q.listMenu()));

// ---------- Customer reorder suggestions (LIFF: "order the same as last time?") ----------
app.get('/api/customers/:lineUserId/suggestions', (req, res) => {
  try { res.json(Q.customerSuggestions(req.params.lineUserId)); }
  catch (e) { res.status(200).json({ known: false, error: e.message }); }
});

// ---------- Stores & zones ----------
app.get('/api/stores', (req, res) => {
  res.json(db.prepare('SELECT * FROM stores ORDER BY id').all());
});
app.get('/api/stores/:storeId/zones', (req, res) => {
  const zones = db.prepare('SELECT * FROM zones WHERE store_id = ? ORDER BY id').all(req.params.storeId);
  res.json(zones);
});
app.get('/api/zones/:zoneId', (req, res) => {
  const z = Q.getZone(req.params.zoneId);
  if (!z) return res.status(404).json({ error: 'zone_not_found' });
  res.json(z);
});
// QR PNG for a zone (points at the LIFF URL when configured) — used by the print poster.
app.get('/api/qr/:zoneId', async (req, res) => {
  const z = Q.getZone(req.params.zoneId);
  if (!z) return res.status(404).end();
  const url = LIFF_ID
    ? `https://liff.line.me/${LIFF_ID}?zone=${z.id}`
    : `${PUBLIC_BASE_URL}/liff/?zone=${z.id}`;
  try {
    const buf = await QRCode.toBuffer(url, { width: 600, margin: 1, color: { dark: '#16314f', light: '#ffffff' } });
    res.type('png').send(buf);
  } catch (e) { res.status(500).end(); }
});
// PromptPay payment QR for a given amount (dynamic QR — pre-fills the amount in the
// payer's bank app). Free, no gateway; the cashier confirms payment manually then taps Paid.
app.get('/api/promptpay-qr', async (req, res) => {
  if (!PAY_ONLINE || !PROMPTPAY_ID) return res.status(404).json({ error: 'promptpay_off' });
  const amount = Math.max(0, Number(req.query.amount) || 0);
  try {
    const payload = generatePayload(PROMPTPAY_ID, amount > 0 ? { amount } : {});
    const buf = await QRCode.toBuffer(payload, { width: 480, margin: 1, color: { dark: '#16314f', light: '#ffffff' } });
    res.set('Cache-Control', 'no-store').type('png').send(buf);
  } catch (e) { res.status(500).json({ error: 'qr_failed' }); }
});
app.get('/api/zones/:zoneId/snapshot', (req, res) => {
  const snap = Q.zoneSnapshot(req.params.zoneId, { reveal: pinValueOK(req) });
  if (!snap) return res.status(404).json({ error: 'zone_not_found' });
  res.json(snap);
});

// ---------- Customer: issue ticket (from LIFF scan) ----------
app.post('/api/zones/:zoneId/tickets', (req, res) => {
  try {
    const zone = Q.getZone(req.params.zoneId);
    if (!zone) return res.status(404).json({ error: 'zone_not_found' });
    const { ticket, ahead } = Q.issueTicket({
      storeId: zone.store_id,
      zoneId: zone.id,
      partySize: Math.max(1, Number(req.body?.partySize || 1)),
      lineUserId: req.body?.lineUserId || null,
      customerName: (req.body?.customerName || '').toString().slice(0, 80) || null,
    });
    emit(zone.id, 'update', (reveal) => Q.zoneSnapshot(zone.id, { reveal }));
    res.json({ ticketId: ticket.id, code: ticket.code, ahead });
  } catch (e) {
    const map = { zone_closed: 423, zone_not_found: 404 };
    res.status(map[e.message] || 400).json({ error: e.message });
  }
});

// Resume: find the caller's active ticket in a zone by their LINE id (survives
// closing the browser/app — the LIFF re-identifies them and gets their number back).
app.post('/api/zones/:zoneId/my-ticket', (req, res) => {
  const t = Q.findActiveTicket(req.params.zoneId, req.body?.lineUserId);
  res.json({ ticket: t ? Q.ticketView(t.id) : null });
});

// Customer self-order (no PIN) — from the LINE app: build a cart, get a queue
// number, then pay at the counter. Order is tagged source='customer', unpaid.
app.post('/api/zones/:zoneId/order', (req, res) => {
  try {
    const r = Q.createOrder(req.params.zoneId, req.body?.items, {
      source: 'customer',
      lineUserId: req.body?.lineUserId || null,
      customerName: (req.body?.customerName || '').toString().slice(0, 80) || null,
      actorId: req.staff?.id || null,
    });
    emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
    res.json({ ticketId: r.ticket.id, code: r.ticket.code, total: r.total });
  } catch (e) {
    if (e.message === 'already_in_queue') {
      return res.status(409).json({ error: 'already_in_queue', ticketId: e.ticketId, code: e.code });
    }
    const map = { zone_closed: 423, zone_not_found: 404, empty_order: 400 };
    res.status(map[e.message] || 400).json({ error: e.message });
  }
});

// ---------- Customer: poll own ticket ----------
app.get('/api/tickets/:ticketId', (req, res) => {
  const v = Q.ticketView(req.params.ticketId);
  if (!v) return res.status(404).json({ error: 'ticket_not_found' });
  res.json(v);
});
// Ownership: a customer may only act on their OWN ticket (matched by LINE user id),
// unless the request carries the cashier PIN. Stops cancel/rate on a guessed ticket id.
const ownsTicket = (req) => {
  if (pinValueOK(req)) return true;
  const t = db.prepare('SELECT line_user_id FROM tickets WHERE id=?').get(req.params.ticketId);
  if (!t) return false;
  return !!t.line_user_id && t.line_user_id === (req.body?.lineUserId || null);
};
app.post('/api/tickets/:ticketId/cancel', (req, res) => {
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  try {
    const t = Q.setStatus(req.params.ticketId, 'cancelled', THRESHOLD);
    emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer rating (no PIN) — defined before the generic /:action route so it isn't captured.
app.post('/api/tickets/:ticketId/rate', (req, res) => {
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  try { res.json(Q.setRating(req.params.ticketId, req.body?.stars)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer declares they paid by PromptPay (no PIN, ownership checked) -> 'claimed',
// so the cashier verifies the transfer and confirms Paid. Before the generic /:action route.
app.post('/api/tickets/:ticketId/claim-paid', (req, res) => {
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  try {
    const r = Q.claimOrderPaid(req.params.ticketId);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer uploads a payment slip -> server verifies it with SlipOK (real transfer,
// exact amount, to OUR account, not a duplicate) and auto-marks the order PAID.
app.post('/api/tickets/:ticketId/verify-slip', async (req, res) => {
  if (!PAY_ONLINE || !SLIPOK_ON) return res.status(404).json({ error: 'slip_off' });
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  const ticketId = req.params.ticketId;
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.payment_status === 'paid') return res.json({ ok: true, paid: true, already: true });
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(req.body?.imageData || '');
  if (!m) return res.status(400).json({ error: 'bad_image' });
  try {
    const fd = new FormData();
    fd.append('files', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'slip.jpg');
    fd.append('log', 'true');                 // verify vs linked bank + flag duplicates
    fd.append('amount', String(order.total)); // SlipOK returns code 1013 on amount mismatch
    const r = await fetch(`https://api.slipok.com/api/line/apikey/${SLIPOK_BRANCH_ID}`, {
      method: 'POST', headers: { 'x-authorization': SLIPOK_API_KEY }, body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success && j.data && j.data.success) {
      Q.setOrderPaid(ticketId, { method: 'slip' });
      const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(ticketId);
      if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
      return res.json({ ok: true, paid: true, amount: j.data.amount });
    }
    return res.status(400).json({ error: 'slip_failed', code: j.code ?? j.data?.code, message: j.message || j.data?.message || '' });
  } catch (e) { return res.status(502).json({ error: 'slipok_unreachable', detail: e.message }); }
});
// Cashier marks an order paid (PIN). Defined before the generic /:action route.
app.post('/api/tickets/:ticketId/paid', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.setOrderPaid(req.params.ticketId, { actorId: req.staff?.id || null, method: req.body?.method || null });
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier cancels/voids a ticket + its order (PIN). Before the generic /:action route.
app.post('/api/tickets/:ticketId/void', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    Q.cancelOrderTicket(req.params.ticketId, THRESHOLD, { actorId: req.staff?.id || null, reason: (req.body?.reason || '').toString().slice(0, 200) || null });
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Cashier (PIN protected) ----------
app.post('/api/zones/:zoneId/call-next', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const { called } = Q.callNext(req.params.zoneId, THRESHOLD);
    emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
    if (called) emit(req.params.zoneId, 'call', { code: called.code });
    res.json({ called: called ? { id: called.id, code: called.code } : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/tickets/:ticketId/:action', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const map = { serve: 'served', skip: 'skipped', noshow: 'no_show' };
  const status = map[req.params.action];
  if (!status) return res.status(404).json({ error: 'unknown_action' });
  try {
    const t = Q.setStatus(req.params.ticketId, status, THRESHOLD);
    emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/zones/:zoneId/open', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const z = Q.setZoneOpen(req.params.zoneId, req.body?.isOpen ? 1 : 0);
  emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
  res.json(z);
});
// Store master open/closed (PIN) — flips every zone so the store is open/closed as a whole.
app.post('/api/store/:storeId/open', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const zoneIds = Q.setStoreOpen(req.params.storeId, req.body?.isOpen ? 1 : 0);
  for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
  res.json({ ok: true, isOpen: req.body?.isOpen ? 1 : 0, zones: zoneIds.length });
});
// Reset the whole queue to start from 0 (PIN-protected; also run by the daily scheduler).
app.post('/api/reset', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  doDailyReset();
  res.json({ ok: true });
});
// Daily report for the cashier (PIN-protected): sales mix + P&L + per-zone breakdown.
app.get('/api/report', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.dailyReport());
});
// Detailed read-only reports for a date (manager/owner): transaction log, payment,
// void/refund, addon, hourly. ?date=YYYY-MM-DD (default today), ?branchId=N (default all).
app.get('/api/reports/detailed', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  res.json(Q.detailedReports({ date, branchId }));
});
// Order history (PIN): completed/cancelled orders today, to re-check after the fact.
app.get('/api/history', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.orderHistory(Number(req.query.limit) || 100));
});
// Daily/monthly sell report from the archive (PIN).
app.get('/api/sales-history', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.salesHistory());
});
// Manually save today's sales into the archive now (PIN) — also runs automatically at the daily reset.
app.post('/api/archive-now', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const r = Q.archiveTodaySales();
  res.json({ ok: true, saved: !!r });
});
// Financial settings used by the P&L (PIN): read + update COGS %, opex, target.
app.get('/api/finance', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.getFinanceSettings());
});
app.post('/api/finance', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.setFinanceSettings(req.body || {}));
});
// Export the current report as an Excel workbook (PIN). Opened directly by the browser.
app.get('/api/report.xlsx', async (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const { buildReportWorkbook } = await import('./report-excel.js');
    const stores = db.prepare('SELECT name FROM stores ORDER BY id LIMIT 1').get();
    const buf = await buildReportWorkbook(Q.dailyReport(), { store: stores?.name || 'YO-DEE Yogurt' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="YO-DEE_Report_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: 'export_failed', detail: e.message }); }
});

// ---------- Menu management + quick-service ordering (PIN) ----------
app.post('/api/menu', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.addMenuItem(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/menu/:id', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.updateMenuItem(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/menu/:id', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.deleteMenuItem(req.params.id));
});
app.post('/api/zones/:zoneId/orders', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.createOrder(req.params.zoneId, req.body?.items, { source: 'cashier', actorId: req.staff?.id || null });
    emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
    res.json({ ticketId: r.ticket.id, code: r.ticket.code, total: r.total });
  } catch (e) {
    const map = { zone_closed: 423, zone_not_found: 404, empty_order: 400 };
    res.status(map[e.message] || 400).json({ error: e.message });
  }
});

// ---------- Live updates (SSE) for cashier & display ----------
// Pass ?pin=XXXX (cashier) to receive real customer names; public/display screens omit it.
app.get('/api/zones/:zoneId/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const reveal = pinValueOK(req);
  res.write(`event: update\ndata: ${JSON.stringify(Q.zoneSnapshot(req.params.zoneId, { reveal }))}\n\n`);
  subscribe(req.params.zoneId, res, { reveal });
});

// ---------- Daily queue reset at midnight (Asia/Bangkok, UTC+7) ----------
function doDailyReset() {
  const zoneIds = Q.resetAllZones();
  for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
  console.log(`[reset] queue reset to 0 for ${zoneIds.length} zones`);
}
function msUntilBangkokMidnight() {
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(17, 0, 0, 0);            // 00:00 Asia/Bangkok = 17:00 UTC
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}
function scheduleDailyReset() {
  setTimeout(() => { doDailyReset(); scheduleDailyReset(); }, msUntilBangkokMidnight());
}
scheduleDailyReset();

app.listen(PORT, () => {
  console.log(`Mobile Queue running on ${PUBLIC_BASE_URL}`);
  console.log(`LINE: ${LINE_ENABLED ? 'ENABLED (real pushes)' : 'STUBBED (logs only — set LINE_* in .env to enable)'}`);
});

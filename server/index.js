import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db, getSetting } from './db.js';
import * as Q from './queue.js';
import { subscribe, emit } from './events.js';
import { LINE_ENABLED, lineMiddleware, replyText } from './line.js';
import QRCode from 'qrcode';

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

// ---- LINE webhook ----
// line.middleware() reads the raw body, validates the x-line-signature, and
// populates req.body.events itself. Do NOT add express.json() here: a second
// body parser on the already-consumed stream throws -> 500 on LINE's Verify.
app.post('/line/webhook', lineMiddleware, async (req, res) => {
  const events = req.body?.events || [];
  for (const ev of events) {
    if (ev.type === 'follow') {
      await replyText(ev.replyToken,
        'Thanks for adding us! Scan the QR at the store to get your queue number.');
    }
  }
  res.sendStatus(200);
});

app.use(express.json({ limit: '1mb' })); // room for uploaded menu photos (base64 data URLs)

// ---- PIN brute-force protection: lock an IP after repeated wrong PINs ----
const PIN_MAX_FAILS = 8, PIN_LOCK_MS = 10 * 60 * 1000;
const pinFails = new Map(); // ip -> { count, until }
const ipOf = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
function pinLocked(ip) { const a = pinFails.get(ip); return !!(a && a.until > Date.now()); }
const pinPresent = (req) => req.get('x-cashier-pin') || req.query.pin || req.body?.pin || null;
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
  res.json({ liffId: LIFF_ID, lineEnabled: LINE_ENABLED, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL, addFriendUrl: ADD_FRIEND_URL, minutesPerGroup: WAIT_PER_GROUP, selfOrder: SELF_ORDER });
});

// ---------- Cashier login check (validates the PIN, no side effects) ----------
app.post('/api/auth', (req, res) => {
  res.json({ ok: pinOK(req) });
});

// ---------- Menu (public read; management is PIN-protected below) ----------
app.get('/api/menu', (req, res) => res.json(Q.listMenu()));

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
// Cashier marks an order paid (PIN). Defined before the generic /:action route.
app.post('/api/tickets/:ticketId/paid', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.setOrderPaid(req.params.ticketId);
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
    Q.cancelOrderTicket(req.params.ticketId, THRESHOLD);
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
    const r = Q.createOrder(req.params.zoneId, req.body?.items);
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

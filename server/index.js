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
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CASHIER_PIN = process.env.CASHIER_PIN || '1234';
const THRESHOLD = Number(process.env.NOTIFY_THRESHOLD || 2);
const WAIT_PER_GROUP = Number(process.env.WAIT_PER_GROUP_MIN || 4); // est. minutes per group ahead
const LIFF_ID = process.env.LIFF_ID || '';
const ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL || '';

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

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const pinOK = (req) =>
  (req.get('x-cashier-pin') || req.query.pin || req.body?.pin) === CASHIER_PIN;

// ---------- Public config (for frontends) ----------
app.get('/api/config', (req, res) => {
  res.json({ liffId: LIFF_ID, lineEnabled: LINE_ENABLED, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL, addFriendUrl: ADD_FRIEND_URL, minutesPerGroup: WAIT_PER_GROUP });
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
  const snap = Q.zoneSnapshot(req.params.zoneId);
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
    emit(zone.id, 'update', Q.zoneSnapshot(zone.id));
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

// ---------- Customer: poll own ticket ----------
app.get('/api/tickets/:ticketId', (req, res) => {
  const v = Q.ticketView(req.params.ticketId);
  if (!v) return res.status(404).json({ error: 'ticket_not_found' });
  res.json(v);
});
app.post('/api/tickets/:ticketId/cancel', (req, res) => {
  try {
    const t = Q.setStatus(req.params.ticketId, 'cancelled', THRESHOLD);
    emit(t.zone_id, 'update', Q.zoneSnapshot(t.zone_id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer rating (no PIN) — defined before the generic /:action route so it isn't captured.
app.post('/api/tickets/:ticketId/rate', (req, res) => {
  try { res.json(Q.setRating(req.params.ticketId, req.body?.stars)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Cashier (PIN protected) ----------
app.post('/api/zones/:zoneId/call-next', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const { called } = Q.callNext(req.params.zoneId, THRESHOLD);
    const snap = Q.zoneSnapshot(req.params.zoneId);
    emit(req.params.zoneId, 'update', snap);
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
    emit(t.zone_id, 'update', Q.zoneSnapshot(t.zone_id));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/zones/:zoneId/open', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const z = Q.setZoneOpen(req.params.zoneId, req.body?.isOpen ? 1 : 0);
  emit(req.params.zoneId, 'update', Q.zoneSnapshot(req.params.zoneId));
  res.json(z);
});
// Reset the whole queue to start from 0 (PIN-protected; also run by the daily scheduler).
app.post('/api/reset', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  doDailyReset();
  res.json({ ok: true });
});
// Daily report for the cashier (PIN-protected): cups sold + per-zone breakdown.
app.get('/api/report', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.dailyReport());
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
    emit(req.params.zoneId, 'update', Q.zoneSnapshot(req.params.zoneId));
    res.json({ ticketId: r.ticket.id, code: r.ticket.code, total: r.total });
  } catch (e) {
    const map = { zone_closed: 423, zone_not_found: 404, empty_order: 400 };
    res.status(map[e.message] || 400).json({ error: e.message });
  }
});

// ---------- Live updates (SSE) for cashier & display ----------
app.get('/api/zones/:zoneId/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`event: update\ndata: ${JSON.stringify(Q.zoneSnapshot(req.params.zoneId))}\n\n`);
  subscribe(req.params.zoneId, res);
});

// ---------- Daily queue reset at midnight (Asia/Bangkok, UTC+7) ----------
function doDailyReset() {
  const zoneIds = Q.resetAllZones();
  for (const id of zoneIds) emit(id, 'update', Q.zoneSnapshot(id));
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

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db, getSetting } from './db.js';
import * as Q from './queue.js';
import { subscribe, emit } from './events.js';
import { LINE_ENABLED, lineMiddleware, replyText } from './line.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CASHIER_PIN = process.env.CASHIER_PIN || '1234';
const THRESHOLD = Number(process.env.NOTIFY_THRESHOLD || 2);
const LIFF_ID = process.env.LIFF_ID || '';

// ---- LINE webhook must be mounted with raw-ish body BEFORE express.json ----
app.post('/line/webhook', lineMiddleware, express.json(), async (req, res) => {
  const events = req.body?.events || [];
  for (const ev of events) {
    if (ev.type === 'follow') {
      await replyText(ev.replyToken,
        'ขอบคุณที่เพิ่มเพื่อน! สแกน QR ที่ร้านเพื่อรับคิว\nThanks! Scan the QR at the store to get a queue number.');
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
  res.json({ liffId: LIFF_ID, lineEnabled: LINE_ENABLED, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL });
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
    });
    emit(zone.id, 'update', Q.zoneSnapshot(zone.id));
    res.json({ ticketId: ticket.id, code: ticket.code, ahead });
  } catch (e) {
    const map = { zone_closed: 423, zone_not_found: 404 };
    res.status(map[e.message] || 400).json({ error: e.message });
  }
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
  const map = { serve: 'served', skip: 'skipped' };
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

app.listen(PORT, () => {
  console.log(`Mobile Queue running on ${PUBLIC_BASE_URL}`);
  console.log(`LINE: ${LINE_ENABLED ? 'ENABLED (real pushes)' : 'STUBBED (logs only — set LINE_* in .env to enable)'}`);
});

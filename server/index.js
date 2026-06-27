import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { db, getSetting, DURABLE, reconnectDb } from './db.js';
import { seedDemo, seedBlank } from '../scripts/seed.js';
import * as Q from './queue.js';
import { verifyPin, signSession, verifySession, parseCookies } from './auth.js';
import { subscribe, emit } from './events.js';
import { LINE_ENABLED, lineMiddleware, replyText, pushText } from './line.js';
import { LINEPAY_ON, reserve as linepayReserve, confirm as linepayConfirm } from './linepay.js';
import { decodeMerchantTemplate, buildDynamicPayload, isInjectable } from './thaiqr.js';
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
// White-label brand config — defaults to YO-DEE so existing deploys are unchanged; a new brand just
// sets these env vars (+ drops its own /assets/logo.png). The frontends read it from /api/brand.
const BRAND = {
  name: process.env.BRAND_NAME || 'YO-DEE Yogurt',
  short: process.env.BRAND_SHORT || 'YO-DEE',
  theme: process.env.BRAND_THEME || '#1e3a5f',
  logo: process.env.BRAND_LOGO || '/assets/logo.png',
  unit: process.env.BRAND_UNIT || 'แก้ว',
  // White-label package: 'line' (full — customer LINE self-order + loyalty + online pay)
  // or 'pos' (mobile POS only — staff ring orders, queue + counter pay, NO customer LINE UI).
  package: (process.env.PACKAGE || 'line').toLowerCase() === 'pos' ? 'pos' : 'line',
};
// Package-1 (POS-only) hides every customer-facing LINE feature regardless of token presence.
const POS_ONLY = BRAND.package === 'pos';
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
// Decode the shop's static merchant QR (public/assets/promptpay.png) once at boot so we can
// re-issue it DYNAMICALLY with the bill amount pre-filled (like a POS). Null if no QR image.
const MERCHANT_QR = PAY_ONLINE ? await decodeMerchantTemplate(join(__dirname, '..', 'public', 'assets', 'promptpay.png')) : null;
// Inject the bill amount into the shop's merchant QR (dynamic). Empirically this is payable
// from most banks' apps via the Bill Payment rail; KBank is the known exception (it routes its
// own merchant QR through its acquirer, which won't accept a customer-set amount).
const MERCHANT_QR_DYNAMIC = Boolean(MERCHANT_QR);
if (MERCHANT_QR) console.log(`[qr] Merchant QR decoded — dynamic amount ON (${isInjectable(MERCHANT_QR) ? 'standard PromptPay P2P' : 'merchant/bill-payment rail; KBank app may not accept the injected amount'}).`);
const PROMPTPAY_DYNAMIC = PAY_ONLINE && (MERCHANT_QR_DYNAMIC || (!MERCHANT_QR && Boolean(PROMPTPAY_ID)));

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
// PWA manifest built from the brand config (so the home-screen app name/icon/colour follow the
// brand). Registered before express.static so it wins over the static file.
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: BRAND.name, short_name: BRAND.short, description: `${BRAND.name}`,
    start_url: '/cashier/', scope: '/', display: 'standalone', orientation: 'any',
    background_color: '#ffffff', theme_color: BRAND.theme, lang: 'th',
    icons: [
      { src: BRAND.logo, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: BRAND.logo, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: BRAND.logo, sizes: 'any', type: 'image/png', purpose: 'maskable' },
    ],
  });
});
app.use(express.static(join(__dirname, '..', 'public'), {
  // HTML must always revalidate so a redeploy reaches the LINE in-app browser / iPad immediately
  // (LIFF caching otherwise serves a stale page); other assets (css/js/img) can cache normally.
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));

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
  res.json({ liffId: LIFF_ID, lineEnabled: LINE_ENABLED, posOnly: POS_ONLY, lineFeatures: !POS_ONLY, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL, addFriendUrl: POS_ONLY ? '' : ADD_FRIEND_URL, minutesPerGroup: WAIT_PER_GROUP, selfOrder: SELF_ORDER && !POS_ONLY, promptPay: PAY_ONLINE && Boolean(MERCHANT_QR || PROMPTPAY_ID || PROMPTPAY_STATIC_URL), promptPayDynamic: PROMPTPAY_DYNAMIC, promptPayStatic: PAY_ONLINE ? (PROMPTPAY_STATIC_URL || null) : null, slipVerify: PAY_ONLINE && SLIPOK_ON && Q.slipAutoEnabled(), linePay: PAY_ONLINE && LINEPAY_ON && !POS_ONLY, printEnabled: Q.printEnabled(), open: Q.isStoreOpen(), hours: Q.getStoreHours(), pendingVoidMinutes: Q.getPendingVoidMinutes(), loyaltyOn: Q.loyaltyEnabled(), loyaltyStamps: Q.getStampsPerReward(), queueFirst: Q.getQueueFirst(), brand: BRAND });
});
// White-label brand (name / short / theme / logo / unit) — public so every page can theme itself.
app.get('/api/brand', (req, res) => res.json(BRAND));

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
// ?channelId=N resolves channel pricing (e.g. delivery markup) for each item.
app.get('/api/menu', (req, res) => res.json(Q.listMenu(req.query.channelId ? Number(req.query.channelId) : null, req.query.branchId ? Number(req.query.branchId) : null)));
// Active sales channels (for the cashier order-channel picker).
app.get('/api/channels', (req, res) => res.json(Q.listChannels().filter((c) => c.active !== 0)));
// ---------- Pricing management (owner): tier markup, channel commission, item prices ----------
app.get('/api/price-tiers', (req, res) => { if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json(Q.listPriceTiers()); });
app.post('/api/price-tiers/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updatePriceTier(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/channels/all', (req, res) => { if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json(Q.listChannels()); });
app.post('/api/channels/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateChannel(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---------- Payment tenders (how money is collected) ----------
// Active tenders for the cashier/customer payment picker (any signed-in staff).
app.get('/api/tenders', (req, res) => res.json(Q.listTenders(false)));
// Owner: manage tenders (rename / toggle / fee%).
app.get('/api/tenders/all', (req, res) => { if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json(Q.listTenders(true)); });
app.post('/api/tenders/:id', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateTender(Number(req.params.id), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
// Per-tender daily settlement totals (reconcile each app/bank payout).
app.get('/api/tender-recon', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.tenderRecon({ date: req.query.date || null, branchId: req.query.branchId ? Number(req.query.branchId) : null }));
});

// ---------- Loyalty points (our own) ----------
// Public loyalty config + active rewards (for the LIFF stamp card). No PIN — read-only.
app.get('/api/loyalty/config', (req, res) => res.json({ enabled: Q.loyaltyEnabled(), stampsPerReward: Q.getStampsPerReward(), welcomeBonus: Q.getWelcomeBonus(), earnMode: Q.getEarnMode(), bahtPerStar: Q.getBahtPerStar(), rewards: Q.listRewards(false) }));
// A customer's balance + recent history (LIFF passes their own line_user_id).
app.get('/api/loyalty/:key', (req, res) => res.json({ ...Q.loyaltyBalance(req.params.key), history: Q.loyaltyHistory(req.params.key) }));
// Redeem a reward. Cashier-driven (PIN) so a staff member hands over the reward at the counter.
app.post('/api/loyalty/:key/redeem', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.redeemReward(req.params.key, Number(req.body?.rewardId), req.staff?.id || null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer saves their own birthday (optional) from the LIFF → birthday free drink.
app.post('/api/loyalty/:key/birthday', (req, res) => {
  try { res.json(Q.setCustomerBirthday(req.params.key, req.body?.birthday)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Referral: this customer's own invite code + whether they can still enter a friend's code.
app.get('/api/loyalty/:key/referral', (req, res) => res.json(Q.referralStatus(req.params.key)));
// A new customer enters a friend's invite code (both get stamps when this customer first orders).
app.post('/api/loyalty/:key/refer', (req, res) => {
  try { res.json(Q.applyReferralCode(req.params.key, req.body?.code)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Owner: manage loyalty settings + rewards.
app.get('/api/rewards/all', (req, res) => { if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json({ enabled: Q.loyaltyEnabled(), stampsPerReward: Q.getStampsPerReward(), welcomeBonus: Q.getWelcomeBonus(), earnMode: Q.getEarnMode(), bahtPerStar: Q.getBahtPerStar(), rewards: Q.listRewards(true) }); });
app.post('/api/loyalty/settings', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = {};
    if (req.body?.enabled != null) Object.assign(out, Q.setLoyaltyEnabled(!!req.body.enabled));
    if (req.body?.stampsPerReward != null) Object.assign(out, Q.setStampsPerReward(req.body.stampsPerReward));
    if (req.body?.welcomeBonus != null) Object.assign(out, Q.setWelcomeBonus(req.body.welcomeBonus));
    if (req.body?.earnMode != null) Object.assign(out, Q.setEarnMode(req.body.earnMode));
    if (req.body?.bahtPerStar != null) Object.assign(out, Q.setBahtPerStar(req.body.bahtPerStar));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Owner toggles for prepared-but-dormant features (SlipOK auto-verify, receipt printing).
app.get('/api/admin/features', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ slipAuto: Q.slipAutoEnabled(), slipReady: PAY_ONLINE && SLIPOK_ON, printEnabled: Q.printEnabled(), ownerLineId: Q.getOwnerLineId(), lineReady: LINE_ENABLED, hours: Q.getStoreHours(), open: Q.isStoreOpen(), pendingVoidMinutes: Q.getPendingVoidMinutes(), queueFirst: Q.getQueueFirst() });
});
app.post('/api/admin/features', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = {};
    if (req.body?.slipAuto != null) Object.assign(out, Q.setSlipAuto(!!req.body.slipAuto));
    if (req.body?.printEnabled != null) Object.assign(out, Q.setPrintEnabled(!!req.body.printEnabled));
    if (req.body?.ownerLineId != null) Object.assign(out, Q.setOwnerLineId(req.body.ownerLineId));
    if (req.body?.pendingVoidMinutes != null) Object.assign(out, Q.setPendingVoidMinutes(req.body.pendingVoidMinutes));
    if (req.body?.queueFirst != null) Object.assign(out, Q.setQueueFirst(!!req.body.queueFirst));
    if (req.body?.hours != null) out.hours = Q.setStoreHours(req.body.hours);
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Manual "clear stale unpaid orders now" — cashier-triggered; mirrors the background sweep.
app.post('/api/pending/sweep', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.sweepStalePending({ actorId: req.staff?.id || null });
    for (const z of r.zones) emit(z, 'update', (reveal) => Q.zoneSnapshot(z, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Push today's summary to the owner's LINE (manual trigger / wireable to a daily cron later).
app.post('/api/admin/owner-summary', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.pushOwnerSummary(req.body?.branchId != null ? Number(req.body.branchId) : null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Owner "start fresh": wipe TEST transaction data (orders/sales/queue/loyalty/cash/audit) and
// reset queue numbers, KEEPING all config (menu/stores/staff/settings/recipes/stock/rewards).
// Owner-only + the client requires a typed "CLEAR" confirmation. Irreversible.
app.post('/api/admin/reset-transactions', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  if (req.body?.confirm !== 'CLEAR') return res.status(400).json({ error: 'confirm_required' });
  try {
    const removed = Q.clearTransactions();
    try { for (const z of db.prepare('SELECT id FROM zones').all()) emit(z.id, 'update', (reveal) => Q.zoneSnapshot(z.id, { reveal })); } catch { /* refresh best-effort */ }
    res.json({ ok: true, removed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/rewards', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.addReward(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/rewards/:id', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateReward(Number(req.params.id), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/item-prices', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.setItemPrice(req.body?.itemId, req.body?.tierId, req.body?.price, req.body?.branchId || 0)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Customer reorder suggestions (LIFF: "order the same as last time?") ----------
app.get('/api/customers/:lineUserId/suggestions', (req, res) => {
  try { res.json(Q.customerSuggestions(req.params.lineUserId)); }
  catch (e) { res.status(200).json({ known: false, error: e.message }); }
});

// ---------- Stores & zones ----------
app.get('/api/stores', (req, res) => {
  res.json(Q.listStores());
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
// Member QR for the customer's "บัตรของฉัน" — encodes a member URL the cashier scanner reads to
// identify them (no typing). The id is the customer's own LINE id; the QR is shown only to them.
app.get('/api/member-qr', async (req, res) => {
  const u = String(req.query.u || '').slice(0, 128);
  if (!u) return res.status(400).end();
  const url = `${PUBLIC_BASE_URL}/m?u=${encodeURIComponent(u)}`;
  try {
    const buf = await QRCode.toBuffer(url, { width: 480, margin: 1, color: { dark: '#16314f', light: '#ffffff' } });
    res.set('Cache-Control', 'no-store').type('png').send(buf);
  } catch (e) { res.status(500).end(); }
});
// PromptPay payment QR for a given amount (dynamic QR — pre-fills the amount in the
// payer's bank app). Free, no gateway; the cashier confirms payment manually then taps Paid.
app.get('/api/promptpay-qr', async (req, res) => {
  if (!PAY_ONLINE || !PROMPTPAY_DYNAMIC) return res.status(404).json({ error: 'promptpay_off' });
  const amount = Math.max(0, Number(req.query.amount) || 0);
  // static=1 → the ORIGINAL no-amount merchant QR. KBank locks the amount on injected
  // (bill-payment) QRs, so KBank customers scan this and type the amount themselves; the
  // slip is then checked by SlipOK against the order total. Other banks use the dynamic QR.
  const wantStatic = String(req.query.static || '') === '1';
  try {
    // Prefer the shop's real merchant QR (K SHOP/Thai QR) with the amount injected; else a
    // plain PromptPay id. Both yield a scannable QR with the bill amount pre-filled.
    const payload = wantStatic
      ? (MERCHANT_QR ? MERCHANT_QR : generatePayload(PROMPTPAY_ID, {}))
      : (MERCHANT_QR ? buildDynamicPayload(MERCHANT_QR, amount) : generatePayload(PROMPTPAY_ID, amount > 0 ? { amount } : {}));
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
  if (POS_ONLY || !SELF_ORDER) return res.status(404).json({ error: 'self_order_off' });
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
// Customer self-cancel = a REQUEST the cashier confirms (it stays on the board, loud). Allowed only
// while the order is unpaid AND not yet being made; rejected once making/paid (the cashier handles it).
app.post('/api/tickets/:ticketId/cancel', (req, res) => {
  try {
    Q.customerRequestCancel(req.params.ticketId, req.body?.lineUserId || null);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json({ ok: true, requested: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier: commit to making a queued order → locks the customer's self-cancel.
app.post('/api/tickets/:ticketId/start-making', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { const t = Q.startMaking(req.params.ticketId, { actorId: req.staff?.id || null });
    emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal })); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier: nudge the LINE customer to pay before the kitchen makes it (queue-first waste guard).
app.post('/api/tickets/:ticketId/ask-pay', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.askToPay(req.params.ticketId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier: keep the order despite a customer cancel request (clears the sticky flag).
app.post('/api/tickets/:ticketId/dismiss-cancel', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { Q.dismissCancelRequest(req.params.ticketId);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal })); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  if (!PAY_ONLINE || !SLIPOK_ON || !Q.slipAutoEnabled()) return res.status(404).json({ error: 'slip_off' });
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
      const pr = Q.setOrderPaid(ticketId, { method: 'online' });   // online QR + SlipOK → 'online' tender
      const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(ticketId);
      if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
      notifyLoyalty(pr);
      return res.json({ ok: true, paid: true, amount: j.data.amount, loyalty: pr.loyalty || null });
    }
    return res.status(400).json({ error: 'slip_failed', code: j.code ?? j.data?.code, message: j.message || j.data?.message || '' });
  } catch (e) { return res.status(502).json({ error: 'slipok_unreachable', detail: e.message }); }
});
// Manual slip attach (works WITHOUT SlipOK): customer uploads a slip image, the cashier
// eyeballs it and confirms paid. Auto-verification (SlipOK) is the verify-slip route above.
app.post('/api/tickets/:ticketId/attach-slip', (req, res) => {
  if (!PAY_ONLINE) return res.status(404).json({ error: 'pay_off' });
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  const img = (req.body?.imageData || '').toString();
  if (!/^data:image\//.test(img) || img.length > 4_000_000) return res.status(400).json({ error: 'bad_image' });
  try {
    const r = Q.attachSlip(req.params.ticketId, img);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer requests a refund (paid online, can't come) — flags it for the cashier in history.
app.post('/api/tickets/:ticketId/request-refund', (req, res) => {
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  try { res.json(Q.requestRefund(req.params.ticketId, (req.body?.reason || '').toString().slice(0, 200) || null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier views the attached slip image to verify manually.
app.get('/api/tickets/:ticketId/slip', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const s = Q.getSlip(req.params.ticketId);
  if (!s) return res.status(404).json({ error: 'no_slip' });
  res.json(s);
});
// LINE Pay (scaffold): reserve a payment → customer is redirected to LINE Pay's page.
app.post('/api/tickets/:ticketId/linepay/reserve', async (req, res) => {
  if (!PAY_ONLINE || !LINEPAY_ON) return res.status(404).json({ error: 'linepay_off' });
  if (!ownsTicket(req)) return res.status(403).json({ error: 'not_owner' });
  const ticketId = req.params.ticketId;
  const order = db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.payment_status === 'paid') return res.json({ ok: true, already: true });
  try {
    const confirmUrl = `${PUBLIC_BASE_URL}/api/linepay/confirm?ticketId=${encodeURIComponent(ticketId)}`;
    const r = await linepayReserve({ amount: order.total, orderId: order.id, productName: `${BRAND.short} order`, confirmUrl, cancelUrl: `${PUBLIC_BASE_URL}/liff/` });
    if (!r.ok) return res.status(400).json({ error: 'linepay_reserve_failed', code: r.code, message: r.message });
    res.json({ ok: true, paymentUrl: r.paymentUrl });
  } catch (e) { res.status(502).json({ error: 'linepay_unreachable', detail: e.message }); }
});
// LINE Pay redirect callback: confirm the transaction, mark paid, award points.
app.get('/api/linepay/confirm', async (req, res) => {
  if (!PAY_ONLINE || !LINEPAY_ON) return res.status(404).send('LINE Pay off');
  const ticketId = req.query.ticketId, transactionId = req.query.transactionId;
  const order = ticketId ? db.prepare('SELECT * FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId) : null;
  if (!order || !transactionId) return res.status(400).send('คำขอไม่ถูกต้อง');
  try {
    if (order.payment_status !== 'paid') {
      const c = await linepayConfirm(transactionId, order.total);
      if (!c.ok) return res.status(400).send('ชำระเงินไม่สำเร็จ: ' + (c.message || c.code || ''));
      const pr = Q.setOrderPaid(ticketId, { method: 'linepay' });
      const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(ticketId);
      if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
      notifyLoyalty(pr);
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ ชำระเงินด้วย LINE Pay สำเร็จ</h2><p>กลับไปที่หน้าแอปเพื่อดูคิวของคุณได้เลย</p><a href="/liff/">เปิดแอป</a></body>');
  } catch (e) { res.status(502).send('LINE Pay error: ' + e.message); }
});
// Cashier applies a bill discount to an order (PIN). Before the generic /:action route.
app.post('/api/tickets/:ticketId/discount', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.setOrderDiscount(req.params.ticketId, {
      amount: req.body?.amount, reason: req.body?.reason || null, actorId: req.staff?.id || null,
    });
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Phone-keyed loyalty (Package 1 — no LINE): attach a phone to a pending ticket so it earns
// stamps on payment, and look up a phone's balance. Cashier-gated; before the /:action route.
app.post('/api/tickets/:ticketId/customer', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.attachCustomerToTicket(req.params.ticketId, req.body?.phone, req.body?.name || null);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/loyalty/phone/:phone', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.loyaltyByPhone(req.params.phone)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// CRM: cashier looks up a customer by phone → full profile (visits, spend, favourites, history,
// points). Works regardless of the loyalty toggle. Cashier-gated.
app.get('/api/customers/phone/:phone', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.lookupCustomerByPhone(req.params.phone)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// CRM: cashier scanned a member QR → look the customer up by their LINE id. Cashier-gated.
app.get('/api/customers/by-line/:lineUserId', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.customerProfile(req.params.lineUserId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// CRM win-back: PREVIEW how many lapsed LINE customers a campaign would reach (owner only, no send).
app.get('/api/crm/lapsed', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const days = Number(req.query.days) || 30;
    const list = Q.lapsedLineCustomers(days);
    res.json({ days, count: list.length, sample: list.slice(0, 5).map((c) => c.name || 'ลูกค้า LINE') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// CRM win-back: SEND the message to lapsed LINE customers. Manager-gated; the UI confirms first.
app.post('/api/crm/winback', async (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await Q.winBackBlast(req.body?.message, { days: Number(req.body?.days) || 30 })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// QR check-in: cashier shows this per-order QR; the customer scans it with LINE to link their
// identity to THIS order (no phone typing). Cashier-gated; returns a PNG.
app.get('/api/tickets/:ticketId/checkin-qr', async (req, res) => {
  if (!pinOK(req)) return res.status(401).end();
  try {
    const token = Q.startCheckin(req.params.ticketId);
    const url = LIFF_ID
      ? `https://liff.line.me/${LIFF_ID}?claim=${req.params.ticketId}&t=${token}`
      : `${PUBLIC_BASE_URL}/liff/?claim=${req.params.ticketId}&t=${token}`;
    const buf = await QRCode.toBuffer(url, { width: 520, margin: 1, color: { dark: '#16314f', light: '#ffffff' } });
    res.set('Cache-Control', 'no-store').type('png').send(buf);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Customer's LIFF claims the order after scanning the check-in QR (links their LINE identity). Public
// (the token in the QR is the auth) — the cashier card then auto-recognises them via the live snapshot.
app.post('/api/tickets/:ticketId/claim', (req, res) => {
  try {
    const r = Q.claimTicket(req.params.ticketId, req.body?.lineUserId, req.body?.token, req.body?.name || null);
    if (r.zoneId != null) emit(r.zoneId, 'update', (reveal) => Q.zoneSnapshot(r.zoneId, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Cashier redeems a loyalty reward against the customer's (LINE) order → free-drink discount.
// The order carries the line_user_id, so no QR/id handshake is needed. Before the /:action route.
app.post('/api/tickets/:ticketId/redeem', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.redeemRewardOnOrder(req.params.ticketId, req.body?.rewardId || null, req.staff?.id || null);
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Fire-and-forget LINE push when a paid order earned loyalty points (never blocks payment).
function notifyLoyalty(r) {
  const l = r && r.loyalty;
  if (l && l.awarded > 0 && l.key) {
    pushText(l.key, `🎉 คุณได้รับ +${l.awarded} ดวง! สะสมรวม ${l.balance} ดวง\nสะสมครบแลกเครื่องดื่มฟรีได้เลยครับ`).catch(() => {});
  }
}
// Cashier marks an order paid (PIN). Defined before the generic /:action route.
app.post('/api/tickets/:ticketId/paid', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.setOrderPaid(req.params.ticketId, { actorId: req.staff?.id || null, method: req.body?.method || null });
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    notifyLoyalty(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Merge-pay: settle several pending bills in one tender (รวมบิล). body: { ticketIds:[], method }.
app.post('/api/orders/pay-multi', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  const ids = Array.isArray(req.body?.ticketIds) ? req.body.ticketIds : [];
  if (ids.length < 2) return res.status(400).json({ error: 'need_two_or_more' });
  try {
    const r = Q.payMulti(ids, { actorId: req.staff?.id || null, method: req.body?.method || null });
    const zones = new Set();
    for (const id of ids) { const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(id); if (t) zones.add(t.zone_id); }
    for (const z of zones) emit(z, 'update', (reveal) => Q.zoneSnapshot(z, { reveal }));
    for (const one of r.results) notifyLoyalty(one);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// แยกจ่ายตามเงิน: take a partial payment toward a bill (PIN). body: { amount, method }.
app.post('/api/tickets/:ticketId/pay-partial', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.payPartial(req.params.ticketId, req.body?.amount, { actorId: req.staff?.id || null, method: req.body?.method || null });
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    if (r.settled) notifyLoyalty(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// แยกจ่ายตามรายการ: settle specific order lines by index (PIN). body: { lineIdxs:[...], method }.
// Marks those items paid (paid_lines) + adds their server-computed subtotal to paid_amount.
app.post('/api/tickets/:ticketId/pay-items', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.payItems(req.params.ticketId, req.body?.lineIdxs, { actorId: req.staff?.id || null, method: req.body?.method || null });
    const t = db.prepare('SELECT zone_id FROM tickets WHERE id=?').get(req.params.ticketId);
    if (t) emit(t.zone_id, 'update', (reveal) => Q.zoneSnapshot(t.zone_id, { reveal }));
    if (r.settled) notifyLoyalty(r);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Edit an unpaid order's items in place (change drink/sweet/topping) — alternative to cancel+rekey.
app.post('/api/tickets/:ticketId/edit-order', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const r = Q.editOrderItems(req.params.ticketId, req.body?.items);
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
    Q.cancelOrderTicket(req.params.ticketId, THRESHOLD, { actorId: req.staff?.id || null, reason: (req.body?.reason || '').toString().slice(0, 200) || null, kind: req.body?.kind === 'waste' ? 'waste' : null, restock: !!req.body?.restock });
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
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  // ?date=YYYY-MM-DD → P&L for that past Bangkok day (recomputed from the durable orders table);
  // omitted/invalid → today. dailyReport validates the date format itself.
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  res.json(Q.dailyReport(req.query.branchId ? Number(req.query.branchId) : null, date));
});
// Detailed read-only reports for a date (manager/owner): transaction log, payment,
// void/refund, addon, hourly. ?date=YYYY-MM-DD (default today), ?branchId=N (default all).
app.get('/api/reports/detailed', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  res.json(Q.detailedReports({ date, branchId }));
});
app.get('/api/reports/insights', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.customerInsights());
});
// ---------- Cash drawer / Z-report (manager/owner) ----------
const cashBranch = (req) => Number(req.query.branchId || req.body?.branchId) || 1;
app.get('/api/cash/session', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.currentCashSession(cashBranch(req)));
});
app.post('/api/cash/open', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.openCashSession(cashBranch(req), { actorId: req.staff?.id || null, openFloat: req.body?.openFloat })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/cash/close', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.closeCashSession(cashBranch(req), { actorId: req.staff?.id || null, countedCash: req.body?.countedCash, note: req.body?.note || null })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Order history (PIN): completed/cancelled orders today, to re-check after the fact.
app.get('/api/history', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.orderHistory(Number(req.query.limit) || 100));
});
// Daily/monthly sell report from the archive (PIN).
app.get('/api/sales-history', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.salesHistory());
});
// Manually save today's sales into the archive now — also runs automatically at the daily reset.
app.post('/api/archive-now', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  // Optional `date` (YYYY-MM-DD) backfills a specific day — e.g. recovering a day whose
  // midnight auto-archive failed. archiveTodaySales upserts (INSERT OR REPLACE), so safe to repeat.
  const date = typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : null;
  const r = Q.archiveTodaySales(date);
  res.json({ ok: true, saved: !!r, date: date || 'today' });
});
// Re-run the midnight close (archive yesterday + restart queue counters) on demand —
// recovers a night the auto-reset failed (e.g. a dropped Turso stream). Manager-gated.
app.post('/api/admin/run-daily-reset', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const zoneIds = resetAllZonesResilient();
    for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
    res.json({ ok: true, zones: zoneIds.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Financial settings used by the P&L (manager/owner): read + update COGS %, opex, target.
app.get('/api/finance', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.getFinanceSettings(req.query.branchId ? Number(req.query.branchId) : null));
});
app.post('/api/finance', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.setFinanceSettings(req.body || {}, req.body?.branchId ? Number(req.body.branchId) : null));
});
// ---------- Branch management (owner) ----------
app.get('/api/branches', (req, res) => { if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json(Q.listBranches()); });
app.post('/api/branches', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.createBranch(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/branches/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateStore(Number(req.params.id), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/branches/:id/menu', (req, res) => { if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json(Q.listBranchMenu(Number(req.params.id))); });
app.post('/api/branches/:id/menu', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.setBranchMenuOverride(Number(req.params.id), Number(req.body?.itemId), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---------- Inventory (manager/owner): raw materials + stock movements ----------
app.get('/api/ingredients', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ summary: Q.inventorySummary(), items: Q.listIngredients() });
});
app.post('/api/ingredients', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.addIngredient(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ingredients/:id', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.updateIngredient(Number(req.params.id), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/ingredients/:id/move', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.recordStockMove(Number(req.params.id), { ...req.body, actorId: req.staff?.id || null })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/ingredients/:id/moves', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.stockMoves(Number(req.params.id)));
});
// Recipe (bill-of-materials) per menu item → drives auto stock deduction on sale.
app.get('/api/menu/:id/recipe', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.getRecipe(Number(req.params.id)));
});
app.post('/api/menu/:id/recipe', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.setRecipe(Number(req.params.id), Array.isArray(req.body?.rows) ? req.body.rows : [])); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Export the current report as an Excel workbook (PIN). Opened directly by the browser.
app.get('/api/report.xlsx', async (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const { buildReportWorkbook } = await import('./report-excel.js');
    const stores = db.prepare('SELECT name FROM stores ORDER BY id LIMIT 1').get();
    const buf = await buildReportWorkbook(Q.dailyReport(), { store: stores?.name || BRAND.name });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="YO-DEE_Report_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: 'export_failed', detail: e.message }); }
});
// Detailed reports / Z-report as a multi-sheet Excel workbook (manager/owner).
app.get('/api/reports/detailed.xlsx', async (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;
    const { buildDetailedWorkbook } = await import('./report-excel.js');
    const stores = db.prepare('SELECT name FROM stores ORDER BY id LIMIT 1').get();
    const data = Q.detailedReports({ date, branchId });
    const buf = await buildDetailedWorkbook(data, { store: stores?.name || BRAND.name, date: date || new Date().toISOString().slice(0, 10) });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="YO-DEE_Detailed_${date || new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: 'export_failed', detail: e.message }); }
});

// ---------- Menu management + quick-service ordering (PIN) ----------
app.post('/api/menu', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { const item = Q.addMenuItem(req.body || {});
    if (req.body?.priceDelivery !== undefined) Q.setMenuDeliveryPrice(item.id, req.body.priceDelivery);
    res.json(item); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/menu/:id', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { const item = Q.updateMenuItem(req.params.id, req.body || {});
    if (req.body?.priceDelivery !== undefined) Q.setMenuDeliveryPrice(Number(req.params.id), req.body.priceDelivery);
    res.json(item); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Reorder a menu item within its category (changes what customer/cashier see in the order grid).
app.post('/api/menu/:id/move', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { res.json(Q.moveMenuItem(req.params.id, req.body?.dir === 'up' ? 'up' : 'down')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/menu/:id', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  res.json(Q.deleteMenuItem(req.params.id));
});
app.post('/api/zones/:zoneId/orders', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try {
    const actorId = req.staff?.id || null;
    const r = Q.createOrder(req.params.zoneId, req.body?.items, { source: 'cashier', actorId,
      channelId: req.body?.channelId ? Number(req.body.channelId) : null,
      clientToken: req.body?.clientToken ? String(req.body.clientToken).slice(0, 64) : null });
    // "สั่งให้ลูกค้าคนนี้": tag the new order to a looked-up customer (phone or LINE) BEFORE pay so
    // the history accrues + the card recognises them. Best-effort; idempotent retries are unaffected.
    if (req.body?.customerKey && r.ticket && !r.idempotent) Q.tagOrderCustomer(r.ticket.id, String(req.body.customerKey).slice(0, 80), req.body?.customerName || null);
    // Optional combined "create + pay" in one request — the cashier picks the tender first, so we
    // skip a whole extra HTTP+DB round-trip (matters most on the remote-DB prod). Pay failure leaves
    // the order as a normal pending bill in "รอชำระเงิน". Both createOrder (by token) and setOrderPaid
    // are idempotent, so a retried request returns the same order — never a duplicate or double-charge.
    let paid = null;
    if (req.body?.pay) { try { paid = Q.setOrderPaid(r.ticket.id, { actorId, method: String(req.body.pay) }); } catch { /* stays pending */ } }
    emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
    res.json({ ticketId: r.ticket.id, code: paid?.code || r.ticket.code, total: r.total, paid: !!paid, number: paid?.number || 0, idempotent: !!r.idempotent });
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
// A stale Turso/libSQL Hrana stream (the free instance idles → the write stream to
// the primary expires) shows up here as "stream not found" / 404 and fails the reset.
// Reconnect to a fresh stream and retry once before giving up.
const STREAM_STALE = /stream not found|stream expired|hrana|stream_expired|not found|404/i;
function resetAllZonesResilient() {
  try { return Q.resetAllZones(); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (DURABLE && STREAM_STALE.test(msg)) {
      console.error('[reset] stale Turso stream — reconnecting + retrying once:', msg);
      reconnectDb();
      return Q.resetAllZones();
    }
    throw e;
  }
}
function doDailyReset() {
  try {
    const zoneIds = resetAllZonesResilient();
    for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
    console.log(`[reset] queue reset to 0 for ${zoneIds.length} zones`);
  } catch (e) {
    // Never let a reset failure crash the process or stop the next night from being scheduled.
    console.error('[reset] failed:', e && e.message);
  }
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

// Background sweep: void abandoned (unpaid) pending orders so they don't pile up on the till.
// Controlled by the owner's "pending:void_min" setting (0 = off). Refreshes any zone it touches.
setInterval(() => {
  try {
    const r = Q.sweepStalePending();
    if (r.voided > 0) for (const z of r.zones) emit(z, 'update', (reveal) => Q.zoneSnapshot(z, { reveal }));
  } catch { /* never let the sweep crash the server */ }
}, 60 * 1000);

// White-label onboarding: SEED=blank makes a brand-new instance create just one store + zone
// (named from BRAND) with NO YO-DEE menu/ingredients — the owner fills in their own. Additive:
// only fires when explicitly set, so YO-DEE (no SEED) is untouched.
if ((process.env.SEED || '').toLowerCase() === 'blank') {
  try {
    const r = seedBlank();
    if (r.seeded) console.log(`[seed] Blank brand boot — created store "${r.store}" + 1 zone (no menu).`);
  } catch (e) { console.error('[seed] blank seed skipped:', e.message); }
}
// Ephemeral (non-durable) deploys — the UAT sandbox — start with an empty DB on every boot.
// Auto-seed the demo store/menu so the app is immediately usable. No-op when durable (prod:
// Turso keeps the real data) or when a store already exists.
else if (!DURABLE) {
  try {
    const r = seedDemo();
    if (r.seeded) console.log(`[seed] Ephemeral boot — seeded demo store + ${r.drinks} drinks (UAT sandbox).`);
    // UAT now MIRRORS prod config (loyalty OFF) so sandbox testing reflects real prod behavior.
    // Prod stays OFF too (seed default '0' + this whole block is skipped when DURABLE). Owner can
    // still flip loyalty on per-environment in ⚙ จัดการ; this just sets the UAT boot default.
    Q.setLoyaltyEnabled(false);
    // Queue-first model is exercised on UAT only; prod stays pay-first (seed '0') until the owner
    // flips it on in ⚙ จัดการ after testing here.
    Q.setQueueFirst(true);
  } catch (e) { console.error('[seed] auto-seed skipped:', e.message); }
}

app.listen(PORT, () => {
  console.log(`Mobile Queue running on ${PUBLIC_BASE_URL}`);
  console.log(`LINE: ${LINE_ENABLED ? 'ENABLED (real pushes)' : 'STUBBED (logs only — set LINE_* in .env to enable)'}`);
});

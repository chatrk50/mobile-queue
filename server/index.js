import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { db, getSetting, setSetting, DURABLE, getTenant, getTenantBySlug, getTenantByDomain, setTenantDomain, listTenants, createTenant, seedTenantDefaults, tenantBrand, updateTenantBrand, startTrial, applyTenantReferral, getTenantByReferral, exportTenant, forgetCustomer, setOwnerPassword, updateOwnerEmail, ownerLoginMatches, ownerTenantsByEmail, ownerStaffId, logAudit, listAudit, deleteTenant, referralStats, createResetToken, validateResetToken, consumeResetToken, createEmailChangeToken, consumeEmailChangeToken } from './db.js';
import { GOOGLE_CLIENT_ID, GOOGLE_ON, verifyGoogleIdToken } from './google.js';
import { seedDemo, seedBlank } from '../scripts/seed.js';
import * as Q from './queue.js';
import { SAAS, runWithTenant, currentTenantId, DEFAULT_TENANT } from './tenant.js';
import { verifyPin, hashPin, signSession, verifySession, parseCookies } from './auth.js';
import { verifyTotp } from './totp.js';
import { listTemplates, templateItems } from './menu-templates.js';
import { subscribe, emit } from './events.js';
import { LINE_ENABLED, lineMiddleware, replyText, pushText, lineConfigured, verifyMessagingToken } from './line.js';
import { LINEPAY_ON, reserve as linepayReserve, confirm as linepayConfirm } from './linepay.js';
import { BILLING_ON, billingStatus, subscribeTenant, prorateUpgrade, cancelSubscription, renewDue, handleWebhook as billingWebhook, billingConfig, getDunningCandidates, logDunningSend, clearDunningLog } from './billing.js';
import { sendEmail } from './email.js';
import { decodeMerchantTemplate, buildDynamicPayload, isInjectable } from './thaiqr.js';
import QRCode from 'qrcode';
import generatePayload from 'promptpay-qr';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

// Branded billing email HTML — used for all payment receipts and billing notifications.
const billingHtml = (name, slug, rows, { body = '', ctaLabel = '', ctaUrl = '' } = {}) => {
  const url = ctaUrl || (slug ? `${BASE_URL}/b/${slug}/cashier/` : `${BASE_URL}/login/`);
  const rowsHtml = rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:42%;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:14px;font-weight:600;color:#1a1a2e">${v}</td></tr>`).join('');
  return `<div style="font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:#f7f7fb;padding:24px 0">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <div style="background:#6366f1;padding:20px 28px"><span style="font-family:Kanit,sans-serif;font-size:20px;font-weight:700;color:#fff">ขายดี KhaiDee</span></div>
  <div style="padding:24px 28px">
    ${name ? `<p style="margin:0 0 14px;font-size:15px;color:#1a1a2e">สวัสดีร้าน <b>${name}</b>,</p>` : ''}
    ${body ? `<p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7">${body}</p>` : ''}
    ${rows.length ? `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;border:1px solid #e5e7eb;border-radius:8px">${rowsHtml}</table>` : ''}
    ${ctaLabel ? `<a href="${url}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none">${ctaLabel} →</a>` : ''}
  </div>
  <div style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">ขายดี KhaiDee · <a href="${BASE_URL}/login/" style="color:#6366f1">khai-dee.com</a></div>
</div></div>`;
};

const app = express();
app.set('trust proxy', true); // Render is behind a proxy — needed for a real req.ip
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');   // don't advertise Express

// ---------- In-process error tracking ----------
const _APP_ERRORS = [];   // ring buffer, capped at 200 entries
const _ERR_CAP = 200;
function logAppError(err, ctx = {}) {
  const entry = {
    ts: new Date().toISOString(),
    message: err && (err.message || String(err)),
    stack: err && err.stack,
    ctx,
  };
  _APP_ERRORS.unshift(entry);
  if (_APP_ERRORS.length > _ERR_CAP) _APP_ERRORS.length = _ERR_CAP;
  console.error('[app-error]', entry.ts, entry.message, ctx);
}
// Security headers on every response: block MIME-sniffing, clickjacking (frame-ancestors),
// referrer leakage, and force HTTPS (HSTS) in SaaS. Sessions get the Secure flag in SaaS too.
const COOKIE_SECURE = SAAS ? '; Secure' : '';
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Hardened CSP: allowlist the few real external origins (Google sign-in, Omise, LINE SDK, fonts)
  // and block everything else — injected <script src=evil>, exfil fetch/form/img to other domains,
  // plugins, and base-tag/clickjacking tricks. ('unsafe-inline' for script/style is kept because
  // the app uses inline handlers; stored-XSS is defended at the source by output encoding.)
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.omise.co https://static.line-scdn.net https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.omise.co https://vault.omise.co https://accounts.google.com https://*.line.me https://*.line-scdn.net",
    "frame-src 'self' https://accounts.google.com https://*.omise.co",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; '));
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (SAAS) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
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
// Our own support channel (a LINE OA / chat link) — shown on help + "ขอความช่วยเหลือ" buttons.
const SUPPORT_LINE_URL = (process.env.SUPPORT_LINE_URL || '').trim();
// Brand + package per request. Single-tenant uses the env BRAND (identical to before); the SaaS
// deployment resolves them from the request's tenant row.
const brandFor = (req) => SAAS ? tenantBrand(req.tenantId, BRAND) : BRAND;
const posOnlyFor = (req) => SAAS ? (brandFor(req).package === 'pos') : POS_ONLY;
// LINE config per request: env in single-tenant; the tenant's own pasted tokens/LIFF in SaaS.
const lineCfgFor = (req) => SAAS
  ? { liffId: getSetting('liff:id', '') || '', lineEnabled: lineConfigured(), addFriendUrl: getSetting('line:add_friend_url', '') || '' }
  : { liffId: LIFF_ID, lineEnabled: LINE_ENABLED, addFriendUrl: ADD_FRIEND_URL };
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

// Capture the raw body so the LINE webhook can verify the per-tenant HMAC signature.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } })); // room for uploaded menu photos (base64 data URLs)

// ---- Tenant resolution (SaaS). In single-tenant mode every request is tenant 1 and this is a
// near no-op. In SaaS mode (SAAS=1) a request under /b/<slug>/… is mapped to that tenant: we
// strip the prefix so all existing routes work unchanged, set req.tenantId, and run the rest of
// the request inside that tenant's AsyncLocalStorage context so the data layer scopes itself. ----
app.use((req, res, next) => {
  let tenantId = DEFAULT_TENANT;
  if (SAAS) {
    // 1) Custom domain → serve that brand at the ROOT (no /b/<slug> prefix needed).
    const byDomain = getTenantByDomain(req.hostname);
    if (byDomain) {
      if (!byDomain.active) return res.status(403).send('บัญชีนี้ถูกระงับการใช้งาน');
      tenantId = byDomain.id;
    } else {
      // 2) Path-based /b/<slug>/… on the shared SaaS host.
      const m = req.url.match(/^\/b\/([a-z0-9-]{1,40})(\/|$|\?)/i);
      if (m) {
        const t = getTenantBySlug(m[1]);
        if (!t) return res.status(404).send('ไม่พบแบรนด์นี้');
        if (!t.active) return res.status(403).send('บัญชีนี้ถูกระงับการใช้งาน');
        tenantId = t.id;
        req.tenantBase = '/b/' + m[1];                           // for the HTML fetch shim below
        req.url = req.url.slice(('/b/' + m[1]).length) || '/';   // strip /b/<slug>
        if (req.url[0] !== '/') req.url = '/' + req.url;
      }
    }
  }
  req.tenantId = tenantId;
  runWithTenant(tenantId, () => next());
});

// Path-based routing only: the app's HTML uses absolute /api & SSE paths, which a browser at
// /b/<slug>/cashier/ would send to ROOT (tenant 1). For HTML pages under /b/<slug>/ we inject a
// tiny shim that prefixes /api & /line & the manifest + EventSource with the tenant base, so the
// page talks to ITS tenant. (Custom-domain routing needs no shim — the Host already resolves it.)
app.use((req, res, next) => {
  if (!req.tenantBase) return next();
  const p = req.path;
  if (!(p.endsWith('/') || p.endsWith('.html'))) return next();   // only HTML pages; assets/api pass through
  const file = join(__dirname, '..', 'public', p.endsWith('/') ? p + 'index.html' : p);
  if (!existsSync(file)) return next();
  let html; try { html = readFileSync(file, 'utf8'); } catch { return next(); }
  const b = JSON.stringify(req.tenantBase);
  const shim = `<script>(function(){var b=${b};var pfx=function(u){return (typeof u==='string'&&(u.indexOf('/api/')===0||u.indexOf('/line/')===0||u==='/manifest.webmanifest'))?b+u:u;};var f=window.fetch;window.fetch=function(u,o){return f.call(this,pfx(u),o);};if(window.EventSource){var E=window.EventSource;var W=function(u,o){return new E(pfx(u),o);};W.prototype=E.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSED=2;window.EventSource=W;}})();</script>`;
  // Fetch tenant brand once; used for OG tags (share page) and iOS meta tag replacement (all pages).
  let tenantBrandCache = null;
  try { tenantBrandCache = brandFor(req); } catch { /* leave null */ }
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let out = html;

  // iOS "Add to Home Screen" app title — overwrite the static "YO-DEE" fallback with tenant short name.
  // Also replace any "YO-DEE Yogurt" / "YO-DEE" in <title> and data-brand-name placeholders server-side
  // so bots/crawlers and no-JS saves see the correct brand.
  if (tenantBrandCache) {
    const shortName = esc(tenantBrandCache.short || tenantBrandCache.name || '');
    if (shortName) out = out.replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,  `$1${shortName}$2`);
    const fullName = esc(tenantBrandCache.name || '');
    if (fullName && fullName !== 'YO-DEE Yogurt') {
      out = out.replace(/(<title>[^<]*?)YO-DEE Yogurt([^<]*?<\/title>)/, `$1${fullName}$2`);
      if (shortName && shortName !== 'YO-DEE') out = out.replace(/(<title>[^<]*?)YO-DEE([^<]*?<\/title>)/, `$1${shortName}$2`);
    }
  }

  // Social OG meta tags for the share page so link previews on LINE/Facebook show the shop brand.
  if (p === '/share/' || p === '/share/index.html') {
    try {
      const brand = tenantBrandCache || brandFor(req);
      const about = getSetting('brand:about', '') || '';
      const title = esc(brand.name || 'ร้านของเรา');
      const desc = esc(about || 'สั่งออเดอร์และรับคิวผ่าน LINE ได้เลย');
      const img = brand.logo && brand.logo.startsWith('http') ? esc(brand.logo) : null;
      const ogInject = `<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${esc(PUBLIC_BASE_URL + req.tenantBase + '/share/')}">` + (img ? `<meta property="og:image" content="${img}">` : '');
      out = out.replace('<meta property="og:image" content="/assets/logo.png">', ogInject + '<meta property="og:image" content="/assets/logo.png">');
      const shopName = esc(brand.name || 'ร้านของเรา');
      out = out.replace('<title>ร้านของเรา — KhaiDee</title>', `<title>${shopName} — KhaiDee</title>`);
    } catch { /* keep static defaults */ }
  }

  out = out.replace('href="/manifest.webmanifest"', `href="${req.tenantBase}/manifest.webmanifest"`);
  res.type('html').send(out.includes('</head>') ? out.replace('</head>', shim + '</head>') : shim + out);
});

// ---- LINE webhook (after tenant resolution, so /b/<slug>/line/webhook validates with THAT
// tenant's channel secret). Body is already parsed + rawBody captured by express.json above. ----
app.post('/line/webhook', lineMiddleware, async (req, res) => {
  const events = req.body?.events || [];
  for (const ev of events) {
    if (ev.type === 'follow') {
      await replyText(ev.replyToken, 'ขอบคุณที่เพิ่มเพื่อนค่ะ! สแกน QR ที่ร้านเพื่อรับหมายเลขคิวได้เลย');
    } else if (ev.type === 'message') {
      await replyText(ev.replyToken, 'ขอบคุณที่ทักมาค่ะ 😊 กรุณาสแกน QR ที่หน้าร้านเพื่อดูเมนูและรับหมายเลขคิวได้เลยนะคะ');
    }
  }
  res.sendStatus(200);
});

// ---- Staff session: a valid signed 'sess' cookie attaches req.staff (Phase 1). This
// runs before routes; legacy x-cashier-pin auth is untouched and still works. ----
app.use((req, res, next) => {
  try {
    const tok = parseCookies(req).sess;
    const p = tok ? verifySession(tok) : null;
    if (p && p.staffId) {
      const s = db.prepare('SELECT id, name, role, tenant_id, active FROM staff WHERE id=?').get(p.staffId);
      // A session is only valid within its own tenant — a cookie from brand A can't drive brand B.
      if (s && s.active && s.tenant_id === req.tenantId) req.staff = { id: s.id, name: s.name, role: s.role, tenantId: s.tenant_id, branchIds: p.branchIds || [] };
    }
  } catch { /* ignore bad cookie */ }
  next();
});

// ---- Tenant boundary guards: a :zoneId / :ticketId in the URL must belong to the request's
// tenant, else 404 (so a guessed id from another brand is invisible). SaaS-only — in
// single-tenant mode tenant 1 owns everything, so these are pure pass-throughs. ----
app.param('zoneId', (req, res, next, zoneId) => {
  if (!SAAS) return next();
  const ok = db.prepare('SELECT 1 FROM zones z JOIN stores s ON s.id=z.store_id WHERE z.id=? AND s.tenant_id=?').get(zoneId, req.tenantId);
  return ok ? next() : res.status(404).json({ error: 'not_found' });
});
app.param('ticketId', (req, res, next, ticketId) => {
  if (!SAAS) return next();
  const ok = db.prepare('SELECT 1 FROM tickets t JOIN zones z ON z.id=t.zone_id JOIN stores s ON s.id=z.store_id WHERE t.id=? AND s.tenant_id=?').get(ticketId, req.tenantId);
  return ok ? next() : res.status(404).json({ error: 'not_found' });
});
app.param('storeId', (req, res, next, storeId) => {
  if (!SAAS) return next();
  const ok = db.prepare('SELECT 1 FROM stores WHERE id=? AND tenant_id=?').get(storeId, req.tenantId);
  return ok ? next() : res.status(404).json({ error: 'not_found' });
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
// IN SAAS MODE the legacy global PIN is DISABLED — it isn't tenant-scoped, so honouring a raw
// x-cashier-pin would be a cross-tenant backdoor. Only the per-tenant staff session authenticates.
const pinPresent = (req) => req.staff ? CASHIER_PIN
  : (SAAS ? null : (req.get('x-cashier-pin') || req.query.pin || req.body?.pin || null));
// Silent check (no fail-counting) — used to decide whether to reveal names.
const pinValueOK = (req) => pinPresent(req) === CASHIER_PIN;
// Block PIN-bearing requests from a locked IP before they hit any handler.
app.use((req, res, next) => {
  if (pinPresent(req) && pinLocked(ipOf(req))) return res.status(429).json({ error: 'too_many_attempts' });
  next();
});
// SaaS: redirect root "/" to the KhaiDee landing page when no tenant slug or custom domain is
// active — i.e. the visitor hit the shared SaaS host directly.
if (SAAS) {
  app.get('/', (req, res, next) => {
    if (!req.tenantBase && req.tenantId === DEFAULT_TENANT && !getTenantByDomain(req.hostname)) {
      return res.redirect(302, '/landing/');
    }
    next();
  });
}

// PWA manifest built from the brand config (so the home-screen app name/icon/colour follow the
// brand). Registered before express.static so it wins over the static file.
app.get('/manifest.webmanifest', (req, res) => {
  const b = brandFor(req);
  res.type('application/manifest+json').json({
    name: b.name, short_name: b.short, description: `${b.name}`,
    start_url: (req.tenantBase || '') + '/cashier/', scope: (req.tenantBase || '') + '/', display: 'standalone', orientation: 'any',
    background_color: '#ffffff', theme_color: b.theme, lang: 'th',
    icons: [
      { src: b.logo, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: b.logo, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: b.logo, sizes: 'any', type: 'image/png', purpose: 'maskable' },
    ],
  });
});
// Sitemap + robots.txt served dynamically so the host is always correct.
app.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const pages = ['/', '/landing/', '/signup/', '/login/', '/help/', '/help/line/', '/privacy/', '/terms/', '/dpa/'];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(p => `  <url><loc>${base}${p}</loc></url>`).join('\n')}\n</urlset>`;
  res.set('Content-Type', 'application/xml').send(xml);
});
app.get('/robots.txt', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: /b/\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
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

// ---------- Health / uptime ----------
// Minimal liveness probe — uptime monitors (UptimeRobot, etc.) ping /health.
app.get('/health', (_req, res) => res.send('ok'));

// Richer status — public JSON, safe to show; used by /public/status.html.
const _startedAt = Date.now();
app.get('/status', (_req, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch {}
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'error',
    uptimeSeconds: Math.floor((Date.now() - _startedAt) / 1000),
    ts: new Date().toISOString(),
  });
});

// ---------- Public config (for frontends) ----------
app.get('/api/config', (req, res) => {
  const posOnly = posOnlyFor(req);
  const lc = lineCfgFor(req);
  res.json({ liffId: lc.liffId, lineEnabled: lc.lineEnabled, posOnly, lineFeatures: !posOnly, threshold: THRESHOLD, baseUrl: PUBLIC_BASE_URL, addFriendUrl: posOnly ? '' : lc.addFriendUrl, minutesPerGroup: WAIT_PER_GROUP, selfOrder: SELF_ORDER && !posOnly, promptPay: PAY_ONLINE && Boolean(MERCHANT_QR || PROMPTPAY_ID || PROMPTPAY_STATIC_URL), promptPayDynamic: PROMPTPAY_DYNAMIC, promptPayStatic: PAY_ONLINE ? (PROMPTPAY_STATIC_URL || null) : null, slipVerify: PAY_ONLINE && SLIPOK_ON && Q.slipAutoEnabled(), linePay: PAY_ONLINE && LINEPAY_ON && !posOnly, printEnabled: Q.printEnabled(), open: Q.isStoreOpen(), hours: Q.getStoreHours(), pendingVoidMinutes: Q.getPendingVoidMinutes(), loyaltyOn: Q.loyaltyEnabled(), loyaltyStamps: Q.getStampsPerReward(), queueFirst: Q.getQueueFirst(), saas: SAAS, supportUrl: SUPPORT_LINE_URL || null, brand: brandFor(req) });
});
// White-label brand (name / short / theme / logo / unit) — public so every page can theme itself.
app.get('/api/brand', (req, res) => res.json(brandFor(req)));

// Public shop profile for the LIFF branded homepage: brand + open status + hours + first-store contact.
app.get('/api/shop/profile', (req, res) => {
  const brand = brandFor(req);
  const hours = Q.getStoreHours();
  const isOpen = Q.isStoreOpen();
  const stores = Q.listStores();
  const loc = stores[0] || null;
  const about = getSetting('brand:about', '') || null;
  const firstZone = loc ? db.prepare('SELECT id FROM zones WHERE store_id=? ORDER BY id LIMIT 1').get(loc.id) : null;
  res.json({ name: brand.name, short: brand.short, theme: brand.theme, logo: brand.logo, unit: brand.unit,
    isOpen, hours, about,
    phone: loc?.phone || null, address: loc?.address || null,
    firstZoneId: firstZone?.id || null });
});

// Public onboarding status — used by the post-signup wizard page; no auth needed.
app.get('/api/onboard', (req, res) => {
  const brand = brandFor(req);
  const menuCount = Q.listMenu().length;
  const lineOk = !!(getSetting('line:token', '') || getSetting('liff:id', ''));
  const stores = Q.listStores();
  const hasHours = stores.some((s) => s.hours_open);
  const hasOrders = Q.monthOrderCount() > 0;
  const tenant = getTenant(req.tenantId);
  const referralCode = tenant?.referral_code || null;
  res.json({ name: brand.name, menuCount, lineOk, hasHours, hasOrders, templates: listTemplates(), referralCode });
});

// ---------- SaaS self-registration (Phase B) ----------
// Public signup → creates a tenant (unique slug + brand), seeds a usable shop (store + Zone A,
// default tiers/channels) and an OWNER staff with the chosen PIN, then returns the live link.
// SaaS-only; rate-limited per IP. The owner logs in at /b/<slug>/cashier/ with their PIN.
const signupHits = new Map(); // ip -> { count, until }
const SIGNUP_MAX = Math.max(1, parseInt(process.env.SIGNUP_MAX || '5', 10) || 5), SIGNUP_WINDOW = 60 * 60 * 1000;
app.post('/api/signup', (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const ip = ipOf(req), now = Date.now();
  const h = signupHits.get(ip);
  if (h && h.until > now && h.count >= SIGNUP_MAX) return res.status(429).json({ error: 'too_many_signups' });
  const name = (req.body?.name || '').toString().trim().slice(0, 80);
  const email = (req.body?.email || '').toString().trim().slice(0, 120);
  const pkg = req.body?.package === 'pos' ? 'pos' : 'line';
  const pin = (req.body?.pin || '').toString().trim();
  const unit = (req.body?.unit || '').toString().trim().slice(0, 16) || null;
  const theme = /^#[0-9a-fA-F]{6}$/.test(req.body?.theme || '') ? req.body.theme : null;
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'pin_must_be_4_8_digits' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  try {
    const t = createTenant({ name, ownerEmail: email || null, pkg, brandShort: name.slice(0, 20), brandTheme: theme, brandUnit: unit });
    runWithTenant(t.id, () => {
      seedTenantDefaults(t.id);
      Q.createBranch({ name });                                  // store + Zone A
      Q.createStaff({ name: 'เจ้าของร้าน', pin, role: 'owner' }); // owner login = the chosen PIN
    });
    // Optional owner password → lets the owner sign in by email later (PIN still runs the till).
    if (req.body?.password && email) { try { setOwnerPassword(t.id, String(req.body.password).slice(0, 100)); } catch { /* non-fatal */ } }
    // Every new shop starts on a full-Pro free trial; a referral code extends both sides.
    const TRIAL_DAYS = Math.max(0, parseInt(process.env.TRIAL_DAYS || '60', 10) || 60);
    const trialUntil = startTrial(t.id, TRIAL_DAYS);
    // Look up the referrer before applying so we can notify them on success.
    const refCode = String(req.body?.ref || '').trim();
    const referrer = refCode ? getTenantByReferral(refCode) : null;
    const referred = referrer ? applyTenantReferral(t.id, refCode) : false;
    const rec = signupHits.get(ip) && signupHits.get(ip).until > now ? signupHits.get(ip) : { count: 0, until: now + SIGNUP_WINDOW };
    rec.count += 1; signupHits.set(ip, rec);
    issueOwnerSession(res, t.id); // auto-login: lets onboard page call protected APIs immediately
    res.json({ ok: true, slug: t.slug, package: pkg, url: `/b/${t.slug}/cashier/`, trialUntil, trialDays: TRIAL_DAYS, founder: !!t.founder, referralCode: t.referral_code, referred });
    // Referral notification to the referrer — fire-and-forget.
    if (referred && referrer?.owner_email) {
      sendEmail({ to: referrer.owner_email, subject: '[ขายดี] มีร้านใหม่สมัครผ่านลิงก์แนะนำของคุณ',
        text: `ร้าน "${name}" สมัคร ขายดี KhaiDee ผ่านลิงก์แนะนำของคุณ\nคุณได้รับการขยายเวลาใช้งาน 30 วันเรียบร้อยแล้ว\n\nขายดี KhaiDee`,
        html: billingHtml(referrer.name, referrer.slug, [['โบนัส', 'ขยายเวลาใช้งาน +30 วัน']], { body: `ร้าน <b>${name}</b> สมัคร ขายดี KhaiDee ผ่านลิงก์แนะนำของคุณ — ขอบคุณที่ช่วยบอกต่อ!`, ctaLabel: 'เข้าระบบเลย' }),
      }).catch(() => {});
    }
    // Welcome email — fire-and-forget, never blocks the response.
    if (email) {
      sendEmail({
        to: email,
        subject: `[ขายดี] ยินดีต้อนรับ "${name}" — พร้อมใช้งานแล้ว!`,
        text: `ร้าน "${name}" พร้อมใช้งานแล้ว!\n\nทดลองใช้ฟรี ${TRIAL_DAYS} วัน (Pro) — ไม่ต้องใส่บัตร\n\nเข้าใช้งาน: ${BASE_URL}/b/${t.slug}/cashier/\n\nขอบคุณที่ใช้บริการ\n— ทีม ขายดี KhaiDee`,
        html: billingHtml(name, t.slug, [['ทดลองใช้ฟรี', `${TRIAL_DAYS} วัน (Pro) — ไม่ต้องใส่บัตร`]], { body: `ร้าน <b>${name}</b> พร้อมใช้งานแล้ว ยินดีต้อนรับสู่ ขายดี KhaiDee!`, ctaLabel: 'เข้าใช้งานเลย' }),
      }).catch(() => {});
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Owner account login (email / Google) — "find my shop" without the slug URL ----------
// Two-layer auth: this signs an OWNER session for the resolved shop; the till still uses PINs.
const ownerHits = new Map();
function issueOwnerSession(res, tenantId) {
  const sid = ownerStaffId(tenantId);
  if (!sid) return false;
  const token = signSession({ staffId: sid, role: 'owner', tenantId, branchIds: [], exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.setHeader('Set-Cookie', `sess=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax${COOKIE_SECURE}`);
  return true;
}
function ownerResult(res, matches, slug) {
  if (!matches.length) return res.status(401).json({ error: 'no_match' });
  const pick = slug ? matches.find((m) => m.slug === slug) : (matches.length === 1 ? matches[0] : null);
  if (!pick) return res.json({ ok: true, choose: matches });        // multiple shops → let them pick
  issueOwnerSession(res, pick.tenantId);
  return res.json({ ok: true, url: `/b/${pick.slug}/cashier/`, tenant: pick });
}
app.get('/api/owner/config', (req, res) => res.json({ saas: SAAS, googleClientId: GOOGLE_ON ? GOOGLE_CLIENT_ID : null, supportUrl: SUPPORT_LINE_URL || null }));
app.post('/api/owner/login', (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const ip = ipOf(req), now = Date.now(); const h = ownerHits.get(ip);
  if (h && h.until > now && h.count >= 10) return res.status(429).json({ error: 'too_many' });
  const matches = ownerLoginMatches(req.body?.email, req.body?.password);
  if (!matches.length) {
    const a = h && h.until > now ? h : { count: 0, until: now + 15 * 60000 }; a.count++; ownerHits.set(ip, a);
    // Send a security alert email the first time the lockout threshold is crossed.
    if (a.count === 10 && req.body?.email) {
      // Only alert if the email is actually registered (avoids sending alert for junk attempts).
      const alertEmail = ownerTenantsByEmail(req.body.email).length ? req.body.email : null;
      if (alertEmail) sendEmail({
        to: alertEmail, subject: 'แจ้งเตือน: มีการพยายามเข้าสู่ระบบหลายครั้งผิดปกติ',
        text: `มีการพยายามเข้าสู่ระบบบัญชี ${alertEmail} ผิดพลาดหลายครั้งจาก IP ${ip}\nบัญชีถูกล็อกชั่วคราว 15 นาที หากไม่ใช่คุณ กรุณาเปลี่ยนรหัสผ่าน`,
        html: `<p>มีการพยายามเข้าสู่ระบบบัญชี <b>${alertEmail}</b> ผิดพลาดหลายครั้งจาก IP <code>${ip}</code></p><p>บัญชีถูกล็อกชั่วคราว 15 นาที หากไม่ใช่คุณ กรุณาเปลี่ยนรหัสผ่านทันที</p>`,
      }).catch(() => {});
    }
  }
  return ownerResult(res, matches, req.body?.slug);
});
app.post('/api/owner/google', async (req, res) => {
  if (!SAAS || !GOOGLE_ON) return res.status(404).json({ error: 'google_off' });
  try {
    const { email } = await verifyGoogleIdToken(req.body?.credential);
    const matches = ownerTenantsByEmail(email);
    if (!matches.length) return res.status(404).json({ error: 'no_shop', email });   // verified, but owns nothing → signup
    return ownerResult(res, matches, req.body?.slug);
  } catch (e) { res.status(401).json({ error: 'bad_google' }); }
});

// ---------- Platform admin (Phase D) — manage ALL tenants. NOT tenant-scoped. ----------
// Gated by SAAS_ADMIN_PIN (env, SaaS service only). Header x-admin-pin or body.adminPin.
const SAAS_ADMIN_PIN = (process.env.SAAS_ADMIN_PIN || '').trim();
// Optional second factor: when SAAS_ADMIN_TOTP_SECRET (a base32 secret) is set, admin login also
// requires a fresh 6-digit TOTP code, and console API calls then ride a short-lived admin session
// cookie (PIN alone is no longer enough). Unset = PIN-only (unchanged). Setup: scripts/admin-2fa-setup.mjs.
const SAAS_ADMIN_TOTP_SECRET = (process.env.SAAS_ADMIN_TOTP_SECRET || '').trim();
const TOTP_ON = SAAS && !!SAAS_ADMIN_TOTP_SECRET;
const ADMIN_SESSION_HOURS = 8;
const adminFails = new Map(); // ip -> { count, until } — brute-force lockout on the platform login
const adminLocked = (ip) => { const a = adminFails.get(ip); return !!(a && a.until > Date.now()); };
const adminPinValid = (req) => SAAS && SAAS_ADMIN_PIN && (req.get('x-admin-pin') === SAAS_ADMIN_PIN || req.body?.adminPin === SAAS_ADMIN_PIN);
const adminBumpFail = (ip) => { const a = adminFails.get(ip) || { count: 0, until: 0 }; a.count++; if (a.count >= 6) { a.until = Date.now() + 15 * 60000; a.count = 0; } adminFails.set(ip, a); };
// Owner account: change email and/or password while holding an owner session.
app.get('/api/owner/account', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const t = getTenant(req.tenantId);
  res.json({ email: t?.owner_email || null, hasPassword: !!(t?.owner_pass_hash) });
});
// Step 1: request an email change — sends a verification link to the NEW address.
app.post('/api/owner/request-email-change', async (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  const token = createEmailChangeToken(req.tenantId, email);
  const tec = getTenant(req.tenantId);
  try {
    const verifyUrl = `${BASE_URL}/api/owner/verify-email-change?token=${encodeURIComponent(token)}`;
    await sendEmail({
      to: email,
      subject: '[ขายดี] ยืนยันการเปลี่ยนอีเมล',
      text: `คลิกลิงก์ด้านล่างเพื่อยืนยันอีเมลใหม่ (หมดอายุใน 24 ชั่วโมง):\n${BASE_URL}/api/owner/verify-email-change?token=${token}\n\nหากไม่ใช่คุณ ไม่ต้องดำเนินการใด`,
      html: billingHtml(tec?.name, null, [], { body: 'คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลใหม่ (หมดอายุใน 24 ชั่วโมง) — หากไม่ใช่คุณ ไม่ต้องดำเนินการใด', ctaLabel: 'ยืนยันอีเมลใหม่', ctaUrl: verifyUrl }),
    });
  } catch { /* non-fatal — token still stored; owner can retry */ }
  logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'owner.request_email_change', detail: 'to=' + email, ip: ipOf(req) });
  res.json({ ok: true, pending: true });
});
// Step 2: verify the token from the email link → apply email change → redirect to login.
app.get('/api/owner/verify-email-change', (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const result = consumeEmailChangeToken(req.query?.token);
  if (!result) return res.redirect('/login/?msg=email_verify_failed');
  logAudit({ tenantId: result.tenantId, actor: 'owner', action: 'owner.email_changed', detail: 'new=' + result.newEmail, ip: ipOf(req) });
  res.redirect('/login/?msg=email_changed');
});
// Legacy direct change (non-SaaS single-tenant or admin tools): still available.
app.post('/api/owner/change-email', (req, res) => {
  if (SAAS) return res.status(410).json({ error: 'use_request_email_change' });
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  updateOwnerEmail(req.tenantId, email);
  logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'owner.change_email', ip: ipOf(req) });
  res.json({ ok: true });
});
app.post('/api/owner/change-password', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });
  setOwnerPassword(req.tenantId, password);
  logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'owner.change_password', ip: ipOf(req) });
  res.json({ ok: true });
});
// Forgot-password flow: request a reset link (always returns ok — no account enumeration).
const forgotHits = new Map(); // ip -> { count, until } — 5 requests per 15 min
app.post('/api/owner/forgot-password', async (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const ip = ipOf(req), now = Date.now();
  const fh = forgotHits.get(ip); if (fh && fh.until > now && fh.count >= 5) return res.json({ ok: true }); // silently rate-limit
  const nfh = fh && fh.until > now ? fh : { count: 0, until: now + 15 * 60000 }; nfh.count++; forgotHits.set(ip, nfh);
  res.json({ ok: true });   // respond immediately — timing-safe, no enumeration
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return;
  const matches = ownerTenantsByEmail(email);
  for (const m of matches) {
    try {
      const token = createResetToken(m.tenantId);
      const resetUrl = `${BASE_URL}/login/?reset=${token}`;
      await sendEmail({
        to: email, subject: '[ขายดี] รีเซ็ตรหัสผ่าน',
        text: `คลิกลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่ (หมดอายุใน 1 ชั่วโมง):\n${BASE_URL}/login/?reset=${token}\n\nหากไม่ใช่คุณ ไม่ต้องดำเนินการใด`,
        html: billingHtml(m.name, null, [], { body: 'คลิกปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่ (หมดอายุใน 1 ชั่วโมง) — หากไม่ใช่คุณ ไม่ต้องดำเนินการใด', ctaLabel: 'ตั้งรหัสผ่านใหม่', ctaUrl: resetUrl }),
      });
    } catch { /* non-fatal */ }
  }
});
// Validate a reset token (GET with ?token= for pre-flight check).
app.get('/api/owner/reset-check', (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const tenantId = validateResetToken(req.query?.token);
  res.json({ ok: !!tenantId });
});
// Consume a reset token and set the new password.
app.post('/api/owner/reset-password', (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });
  const ok = consumeResetToken(req.body?.token, password);
  if (!ok) return res.status(400).json({ error: 'token_invalid_or_expired' });
  res.json({ ok: true });
});
function adminTry(req) {                                  // PIN-on-every-request path (used when 2FA off)
  const ip = ipOf(req);
  if (adminPinValid(req)) { adminFails.delete(ip); return true; }
  adminBumpFail(ip);
  return false;
}
const adminSessionOK = (req) => { try { const t = parseCookies(req).asess; const p = t ? verifySession(t) : null; return !!(p && p.admin === true); } catch { return false; } };
const adminGate = (req, res, next) => {
  if (adminLocked(ipOf(req))) return res.status(429).json({ error: 'too_many' });
  if (adminSessionOK(req)) return next();                 // logged-in admin session (always accepted)
  if (TOTP_ON) return res.status(401).json({ error: 'admin_2fa' });  // 2FA on → PIN alone is insufficient
  return adminTry(req) ? next() : res.status(401).json({ error: 'admin_auth' });
};
// Console login: PIN (rate-limited) + TOTP when enabled → issues a signed admin session cookie.
app.post('/admin/api/login', (req, res) => {
  const ip = ipOf(req);
  if (adminLocked(ip)) return res.status(429).json({ ok: false, error: 'too_many' });
  if (!adminPinValid(req)) { adminBumpFail(ip); return res.json({ ok: false, totpRequired: TOTP_ON }); }
  if (TOTP_ON) {                                          // require the rotating code too
    const code = String(req.body?.totp || '').trim();
    if (!verifyTotp(SAAS_ADMIN_TOTP_SECRET, code)) { adminBumpFail(ip); return res.json({ ok: false, totpRequired: true, error: code ? 'bad_totp' : 'totp' }); }
  }
  adminFails.delete(ip);                                  // clear the lockout counter only on FULL success
  if (!TOTP_ON) return res.json({ ok: true });            // PIN-only mode: unchanged, no admin session
  // 2FA passed → issue a short-lived admin session cookie (console rides it; PIN alone now insufficient).
  const token = signSession({ admin: true, exp: Date.now() + ADMIN_SESSION_HOURS * 3600 * 1000 });
  res.setHeader('Set-Cookie', `asess=${token}; HttpOnly; Path=/; Max-Age=${ADMIN_SESSION_HOURS * 3600}; SameSite=Lax${COOKIE_SECURE}`);
  res.json({ ok: true });
});
// All tenants + a few counts for the console.
app.get('/admin/api/tenants', adminGate, (req, res) => {
  const rows = listTenants().map((t) => {
    const bs = billingStatus(t.id);
    return {
      ...t,
      stores: db.prepare('SELECT COUNT(*) c FROM stores WHERE tenant_id=?').get(t.id).c,
      orders: db.prepare('SELECT COUNT(*) c FROM orders o JOIN stores s ON s.id=o.branch_id WHERE s.tenant_id=?').get(t.id).c,
      plan: Q.tenantPlan(t.id).name,
      ordersThisMonth: Q.monthOrderCount(t.id),
      lineCustomers: runWithTenant(t.id, () => Q.countLineCustomers()),
      daysLeft: bs.daysLeft,
      trial: bs.trial,
      expiringSoon: bs.expiringSoon,
    };
  });
  res.json({ tenants: rows, plans: Q.listPlans() });
});
// Admin sets a tenant's plan (manual billing — automated payment provider plugs in later).
app.post('/admin/api/tenants/:id/plan', adminGate, (req, res) => {
  try { const plan = Q.setTenantPlan(Number(req.params.id), String(req.body?.plan || ''));
    logAudit({ tenantId: Number(req.params.id), actor: 'admin', action: 'tenant.plan', detail: 'plan=' + plan, ip: ipOf(req) });
    res.json({ ok: true, plan }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Map a custom domain to a tenant (the owner points DNS + the host adds the cert separately).
app.post('/admin/api/tenants/:id/domain', adminGate, (req, res) => {
  try { const t = setTenantDomain(Number(req.params.id), req.body?.domain || '');
    logAudit({ tenantId: Number(req.params.id), actor: 'admin', action: 'tenant.domain', detail: 'domain=' + (t.domain || '(cleared)'), ip: ipOf(req) });
    res.json({ ok: true, domain: t.domain || null }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/admin/api/tenants/:id/suspend', adminGate, (req, res) => {
  if (Number(req.params.id) === 1) return res.status(400).json({ error: 'cannot_suspend_primary' });
  db.prepare('UPDATE tenants SET active=0 WHERE id=?').run(Number(req.params.id));
  logAudit({ tenantId: Number(req.params.id), actor: 'admin', action: 'tenant.suspend', ip: ipOf(req) });
  res.json({ ok: true });
});
app.post('/admin/api/tenants/:id/activate', adminGate, (req, res) => {
  db.prepare('UPDATE tenants SET active=1 WHERE id=?').run(Number(req.params.id));
  logAudit({ tenantId: Number(req.params.id), actor: 'admin', action: 'tenant.activate', ip: ipOf(req) });
  res.json({ ok: true });
});
// Reset a locked-out brand owner's PIN to a fresh random one (returned once to the admin).
app.post('/admin/api/tenants/:id/reset-pin', adminGate, (req, res) => {
  const id = Number(req.params.id);
  const t = getTenant(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const newPin = String(Math.floor(1000 + Math.random() * 9000));
  const owner = db.prepare("SELECT id FROM staff WHERE tenant_id=? AND role='owner' AND active=1 ORDER BY id LIMIT 1").get(id);
  if (!owner) return res.status(404).json({ error: 'no_owner' });
  db.prepare('UPDATE staff SET pin_hash=? WHERE id=?').run(hashPin(newPin), owner.id);
  logAudit({ tenantId: id, actor: 'admin', action: 'tenant.reset_pin', detail: 'owner_staff=' + owner.id, ip: ipOf(req) });   // never log the new PIN
  res.json({ ok: true, pin: newPin });
});
// Audit trail (platform admin): recent sensitive actions, optionally scoped ?tenantId=N.
app.get('/admin/api/errors', adminGate, (_req, res) => res.json({ errors: _APP_ERRORS }));

// Dunning email management (admin-only).
app.get('/admin/api/dunning/preview', adminGate, (_req, res) => {
  const candidates = getDunningCandidates();
  res.json({ candidates, count: candidates.length });
});
app.post('/admin/api/dunning/send', adminGate, async (_req, res) => {
  const candidates = getDunningCandidates();
  const results = [];
  const TEMPLATES = {
    trial_7d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" เหลือ 7 วัน`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro เหลือ 7 วัน กรุณาเพิ่มบัตรเครดิตเพื่อใช้งานต่อโดยไม่หยุดชะงัก\n\nขอบคุณที่ใช้บริการ ขายดี KhaiDee`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>เหลือ 7 วัน</b> — เพิ่มบัตรเครดิตเพื่อใช้งานต่อโดยไม่หยุดชะงัก', ctaLabel: 'อัปเกรดเลย' }) }),
    trial_3d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" เหลือ 3 วัน`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro เหลือ 3 วัน เพิ่มบัตรเครดิตตอนนี้เพื่อไม่ให้บริการหยุดชะงัก\n\nขอบคุณที่ใช้บริการ ขายดี KhaiDee`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>เหลือ 3 วัน</b> — เพิ่มบัตรเครดิตตอนนี้เพื่อไม่ให้บริการหยุดชะงัก', ctaLabel: 'อัปเกรดเลย' }) }),
    trial_1d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" หมดพรุ่งนี้!`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro หมดพรุ่งนี้! เพิ่มบัตรเครดิตด่วนเพื่อรักษา LINE และข้อมูลลูกค้า\n\nขอบคุณที่ใช้บริการ ขายดี KhaiDee`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>จะหมดพรุ่งนี้</b>! เพิ่มบัตรเครดิตด่วนเพื่อรักษา LINE และข้อมูลลูกค้าของคุณ', ctaLabel: 'อัปเกรดด่วน' }) }),
    lapsed:   (c) => ({ subject: `[ขายดี] แพ็กเกจ "${c.name}" หมดอายุแล้ว`, text: `ร้าน "${c.name}" กลับสู่โหมดฟรีแล้ว อัปเกรดเพื่อใช้ฟีเจอร์เต็มรูปแบบ\n\nขอบคุณที่ใช้บริการ ขายดี KhaiDee`, html: billingHtml(c.name, c.slug, [], { body: 'แพ็กเกจของร้านคุณ<b>หมดอายุแล้ว</b> และกลับสู่โหมดฟรี — อัปเกรดเพื่อกลับมาใช้ LINE, รายงาน และฟีเจอร์ Pro ครบรูปแบบ', ctaLabel: 'อัปเกรดเลย' }) }),
  };
  for (const c of candidates) {
    const tmpl = TEMPLATES[c.event]?.(c) || { subject: `[ขายดี] แจ้งเตือน ${c.event}`, text: `สวัสดีคุณ ${c.name}` };
    const result = await sendEmail({ to: c.email, ...tmpl });
    logDunningSend(c.tenantId, c.event, { dryRun: result.dryRun || false, toEmail: c.email });
    results.push({ ...c, ...result });
  }
  res.json({ sent: results.length, results });
});
app.get('/admin/api/audit', adminGate, (req, res) => {
  const tid = req.query.tenantId ? Number(req.query.tenantId) : null;
  res.json({ events: listAudit({ tenantId: tid, limit: Number(req.query.limit) || 200 }) });
});
// Referral / growth overview (who invited whom, counts, headline metrics).
app.get('/admin/api/referrals', adminGate, (req, res) => res.json(referralStats()));
// Tenant health / churn signals: trials/plans expiring soon, inactive shops, plan mix, rough MRR.
app.get('/admin/api/health', adminGate, (req, res) => {
  const now = Date.now();
  const prices = billingConfig().prices || {};
  const monthlyBaht = (plan) => Math.round(((prices[plan] && prices[plan].month) || 0) / 100); // satang → ฿/mo
  const rows = db.prepare('SELECT id, name, slug, plan_name, plan_until, auto_renew, active, created_at FROM tenants WHERE id>1 ORDER BY id').all()
    .map((t) => ({
      id: t.id, name: t.name, slug: t.slug, active: !!t.active,
      plan: Q.tenantPlan(t.id).name,                                                  // effective (expiry-aware)
      autoRenew: !!t.auto_renew,
      daysLeft: t.plan_until ? Math.ceil((new Date(t.plan_until).getTime() - now) / 86400000) : null,
      ordersThisMonth: Q.monthOrderCount(t.id),
      createdAt: t.created_at,
    }));
  const planCounts = {};
  for (const r of rows) planCounts[r.plan] = (planCounts[r.plan] || 0) + 1;
  const paying = rows.filter((r) => r.active && (r.plan === 'pro' || r.plan === 'business') && r.autoRenew);
  const mrrBaht = paying.reduce((s, r) => s + monthlyBaht(r.plan), 0);
  const expiringSoon = rows.filter((r) => r.active && r.daysLeft != null && r.daysLeft >= 0 && r.daysLeft <= 7).sort((a, b) => a.daysLeft - b.daysLeft);
  const inactive = rows.filter((r) => r.active && r.ordersThisMonth === 0);
  res.json({
    summary: {
      total: rows.length, active: rows.filter((r) => r.active).length, suspended: rows.filter((r) => !r.active).length,
      paying: paying.length, mrrBaht, planCounts, expiringSoonCount: expiringSoon.length, inactiveCount: inactive.length,
    },
    expiringSoon, inactive, rows,
  });
});
// Export ALL of one tenant's data as JSON (PDPA portability / pre-deletion snapshot).
app.get('/admin/api/tenants/:id/export', adminGate, (req, res) => {
  const id = Number(req.params.id);
  if (!getTenant(id)) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Content-Disposition', `attachment; filename="tenant-${id}-export.json"`);
  logAudit({ tenantId: id, actor: 'admin', action: 'tenant.export', ip: ipOf(req) });
  res.json(exportTenant(id));
});
// PDPA erasure / account close-out: hard-delete a tenant + every row it owns. Irreversible, so it
// requires the slug as a typed confirmation, refuses tenant 1, and is audit-logged.
app.post('/admin/api/tenants/:id/delete', adminGate, (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'cannot_delete_primary' });
  const t = getTenant(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (String(req.body?.confirm || '') !== t.slug) return res.status(400).json({ error: 'confirm_mismatch' });
  try {
    const r = deleteTenant(id);
    logAudit({ tenantId: id, actor: 'admin', action: 'tenant.delete', detail: 'slug=' + t.slug + ' rows=' + Object.values(r.counts).reduce((a, b) => a + b, 0), ip: ipOf(req) });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Cashier login check (validates the PIN, no side effects) ----------
app.post('/api/auth', (req, res) => {
  res.json({ ok: pinOK(req) });
});

// ---------- Staff auth & roles (Phase 1) ----------
// The legacy admin PIN supplied DIRECTLY (header/query/body) — NOT via a session.
// (pinValueOK is true for any logged-in staff, so it must not gate owner actions.)
// Single-tenant only: the shop's own global PIN grants owner/manager. DISABLED in SaaS (would be
// a cross-tenant backdoor) — there, role comes solely from the per-tenant session.
const legacyAdminPin = (req) => !SAAS && (req.get('x-cashier-pin') || req.query.pin || req.body?.pin) === CASHIER_PIN;
// Owner-level access = a logged-in OWNER session OR the legacy admin CASHIER_PIN.
const ownerOK = (req) => req.staff?.role === 'owner' || legacyAdminPin(req);
// Manager-level = owner/manager session OR legacy admin PIN (reports, finance).
const managerOK = (req) => ['owner', 'manager'].includes(req.staff?.role) || legacyAdminPin(req);
// Audit-trail actor label for an owner/manager request (session staff id, else legacy 'owner').
const ownerActor = (req) => (req.staff?.id ? 'owner:' + req.staff.id : 'owner');
const SESSION_HOURS = 12;

// Staff PIN login -> signed httpOnly session cookie identifying who is at the till.
app.post('/api/staff/login', (req, res) => {
  const ip = ipOf(req);
  if (pinLocked(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const pin = (req.body?.pin || '').toString();
  if (!pin) return res.status(400).json({ error: 'pin_required' });
  // Match only staff of THIS tenant — the same PIN at another brand is a different person.
  const staff = db.prepare('SELECT * FROM staff WHERE active=1 AND tenant_id=?').all(req.tenantId).find((s) => verifyPin(pin, s.pin_hash));
  if (!staff) { countPinFail(ip); return res.status(401).json({ error: 'bad_pin' }); }
  pinFails.delete(ip);
  const branchIds = staff.role === 'owner' ? []
    : db.prepare('SELECT branch_id FROM staff_branches WHERE staff_id=?').all(staff.id).map((r) => r.branch_id);
  const token = signSession({ staffId: staff.id, role: staff.role, tenantId: staff.tenant_id, branchIds, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.setHeader('Set-Cookie', `sess=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax${COOKIE_SECURE}`);
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
app.get('/api/loyalty/config', (req, res) => res.json({ enabled: Q.loyaltyEnabled(), stampsPerReward: Q.getStampsPerReward(), welcomeBonus: Q.getWelcomeBonus(), tiers: Q.getTiers(), rewards: Q.listRewards(false) }));
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
app.get('/api/rewards/all', (req, res) => { if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' }); res.json({ enabled: Q.loyaltyEnabled(), stampsPerReward: Q.getStampsPerReward(), welcomeBonus: Q.getWelcomeBonus(), tiers: Q.getTiers(), rewards: Q.listRewards(true) }); });
app.post('/api/loyalty/settings', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = {};
    if (req.body?.enabled != null) Object.assign(out, Q.setLoyaltyEnabled(!!req.body.enabled));
    if (req.body?.stampsPerReward != null) Object.assign(out, Q.setStampsPerReward(req.body.stampsPerReward));
    if (req.body?.welcomeBonus != null) Object.assign(out, Q.setWelcomeBonus(req.body.welcomeBonus));
    if (req.body?.tiers != null) { if (!ownerOK(req)) return res.status(403).json({ error: 'owner_only' }); Object.assign(out, Q.setTiers(req.body.tiers)); }
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---- Promo broadcasts (adopt-backlog #2): owner-only LINE multicast to owned customers ----
app.get('/api/promos/audience', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ count: Q.countLineCustomers(), lineConfigured: lineConfigured(req.tenantId) });
});
app.get('/api/promos', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(Q.listPromos());
});
app.post('/api/promos', async (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const { message, imageUrl, linkUrl, linkLabel, sendAt, sendNow } = req.body || {};
  let promo;
  try { promo = Q.createPromo({ message, imageUrl, linkUrl, linkLabel, sendAt: sendAt || null }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  // sendNow=true or no scheduled time → fire immediately
  if (sendNow || !sendAt) {
    try {
      const { multicastToCustomers } = await import('./line.js');
      const result = await multicastToCustomers(req.tenantId, { message, imageUrl, linkUrl, linkLabel });
      Q.markPromoSent(promo.id, { recipients: result.sent });
      return res.json({ ok: true, id: promo.id, sent: result.sent, stub: result.stub });
    } catch (e) {
      Q.markPromoFailed(promo.id);
      return res.status(500).json({ error: 'send_failed', detail: e.message });
    }
  }
  res.json({ ok: true, id: promo.id, status: promo.status });
});
app.delete('/api/promos/:id', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(Q.cancelPromo(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Per-tenant brand editor (Phase E.3). Owner edits their brand name/short/theme/unit and
// uploads a logo (stored as a data URL in the tenant row). SaaS-only — single-tenant uses env. ----
app.get('/api/admin/brand', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ saas: SAAS, ...brandFor(req), about: getSetting('brand:about', '') || '' });
});
// Owner sees their plan + this-month usage (quota).
app.get('/api/admin/usage', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ saas: SAAS, ...Q.tenantUsage() });
});
// ---- PDPA: data portability + erasure (owner only) ----
app.get('/api/admin/export', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Content-Disposition', `attachment; filename="data-export-${brandFor(req).slug || req.tenantId}.json"`);
  logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'pdpa.export', ip: ipOf(req) });
  res.json(exportTenant(req.tenantId));
});
app.post('/api/admin/forget-customer', (req, res) => {       // body: { phone } or { key } — PDPA erasure
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try { const r = forgetCustomer(req.tenantId, { phone: req.body?.phone || null, key: req.body?.key || null });
    logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'pdpa.forget', detail: 'found=' + !!r.found, ip: ipOf(req) });   // never log the phone/key itself
    res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// ---- Sales CSV export — owner/manager accounting download ----
app.get('/api/export/orders.csv', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const tid = req.tenantId;
  const stores = `(SELECT id FROM stores WHERE tenant_id=${Number(tid)})`;
  // Date range: ?from=YYYY-MM-DD&to=YYYY-MM-DD (Bangkok date); default = last 30 days.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.to   || '') ? req.query.to   : null;
  const dateFilter = from || to
    ? `AND date(o.paid_at,'+7 hours') BETWEEN '${from || '2000-01-01'}' AND '${to || '9999-12-31'}'`
    : `AND date(o.paid_at,'+7 hours') >= date('now','+7 hours','-30 days')`;
  const rows = db.prepare(
    `SELECT o.id, o.paid_at, o.total, o.discount, o.payment_status,
            s.name AS store_name,
            (SELECT GROUP_CONCAT(oi.qty||'×'||oi.name, '; ')
             FROM order_items oi WHERE oi.order_id=o.id) AS items
     FROM orders o
     JOIN stores s ON s.id=o.branch_id
     WHERE o.branch_id IN ${stores} AND o.payment_status IN ('paid','void') ${dateFilter}
     ORDER BY o.paid_at DESC LIMIT 5000`
  ).all();
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const headers = ['วันที่','เวลา','ออเดอร์#','สาขา','รายการ','ยอดรวม','ส่วนลด','ยอดสุทธิ','สถานะ'];
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) {
    const dt = r.paid_at ? new Date(String(r.paid_at).replace(' ', 'T') + 'Z') : null;
    const date = dt ? dt.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' }) : '';
    const time = dt ? dt.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '';
    const net = Math.round(((r.total || 0) - (r.discount || 0)) * 100) / 100;
    lines.push([date, time, r.id, r.store_name, r.items || '', r.total || 0, r.discount || 0, net, r.payment_status].map(esc).join(','));
  }
  const slug = brandFor(req).slug || tid;
  const label = from ? `${from}_to_${to || 'now'}` : 'last30days';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${slug}-${label}.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM for Excel Thai support
});
// ---- Self-service billing (Omise subscription) ----
app.get('/api/billing/status', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const bs = billingStatus(req.tenantId);
  // Attach order-quota usage so the cashier panel can warn free tenants approaching the 500/mo limit.
  // Always attached regardless of BILLING_ON — the limit is enforced even without Omise configured.
  if (bs.plan === 'free') {
    const u = Q.tenantUsage(req.tenantId);
    bs.ordersThisMonth = u.ordersThisMonth;
    bs.maxOrdersPerMonth = u.maxOrdersPerMonth;
  }
  res.json(bs);
});
app.post('/api/billing/subscribe', async (req, res) => {       // body: { token, plan, interval, email }
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await subscribeTenant(req.tenantId, req.body?.token, { plan: req.body?.plan, interval: req.body?.interval, email: req.body?.email || null });
    clearDunningLog(req.tenantId); // fresh start on renewal — allow future dunning cycle
    res.json(r);
    // Payment receipt — fire-and-forget.
    const t0 = getTenant(req.tenantId); if (t0?.owner_email) {
      const planLabel = (r.plan === 'business' ? 'Business' : 'Pro') + ' ' + (r.interval === 'year' ? 'รายปี' : 'รายเดือน');
      const until = r.planUntil ? new Date(r.planUntil).toLocaleDateString('th-TH') : '';
      sendEmail({ to: t0.owner_email, subject: `[ขายดี] ใบเสร็จ — ${planLabel}`,
        text: `ขอบคุณสำหรับการสมัคร ${planLabel}\nใช้งานได้ถึง: ${until}\n\nขายดี KhaiDee`,
        html: billingHtml(t0.name, t0.slug, [['แพ็กเกจ', planLabel], ['ใช้งานได้ถึง', until]], { body: `สมัครแพ็กเกจ <b>${planLabel}</b> สำเร็จแล้ว ขอบคุณที่ไว้วางใจ ขายดี KhaiDee`, ctaLabel: 'เข้าระบบเลย' }),
      }).catch(() => {});
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/billing/upgrade', async (req, res) => {  // body: { plan, interval } — card already on file
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await prorateUpgrade(req.tenantId, { plan: req.body?.plan, interval: req.body?.interval });
    clearDunningLog(req.tenantId);
    res.json(r);
    // Payment receipt — fire-and-forget.
    const t1 = getTenant(req.tenantId); if (t1?.owner_email) {
      const planLabel = (r.plan === 'business' ? 'Business' : 'Pro') + ' ' + (r.interval === 'year' ? 'รายปี' : 'รายเดือน');
      const charged = '฿' + Math.round((r.charged || 0) / 100).toLocaleString('en-US');
      const credit = r.credit ? ' (ส่วนลดตามสัดส่วน ฿' + Math.round(r.credit / 100).toLocaleString('en-US') + ')' : '';
      const until = r.planUntil ? new Date(r.planUntil).toLocaleDateString('th-TH') : '';
      sendEmail({ to: t1.owner_email, subject: `[ขายดี] ใบเสร็จอัปเกรด — ${planLabel}`,
        text: `อัปเกรดเป็น ${planLabel} สำเร็จ\nยอดชำระ: ${charged}${credit}\nใช้งานได้ถึง: ${until}\n\nขายดี KhaiDee`,
        html: billingHtml(t1.name, t1.slug, [['แพ็กเกจ', planLabel], ['ยอดชำระ', `${charged}${credit}`], ['ใช้งานได้ถึง', until]], { body: `อัปเกรดเป็น <b>${planLabel}</b> สำเร็จแล้ว`, ctaLabel: 'เข้าระบบเลย' }),
      }).catch(() => {});
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/billing/cancel', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const result = cancelSubscription(req.tenantId);
  res.json(result);
  // Cancellation confirmation — fire-and-forget.
  const tc = getTenant(req.tenantId); if (tc?.owner_email) {
    const until = result.planUntil ? new Date(result.planUntil).toLocaleDateString('th-TH') : '';
    sendEmail({ to: tc.owner_email, subject: '[ขายดี] ยืนยันการยกเลิกต่ออายุ',
      text: `รับทราบการยกเลิกต่ออายุอัตโนมัติแล้ว\nคุณยังใช้งานได้ถึง: ${until}\nหากต้องการกลับมาใช้ อัปเกรดได้ที่ ⚙ ตั้งค่า > แพ็กเกจ\n\nขายดี KhaiDee`,
      html: billingHtml(tc.name, tc.slug, [['ใช้งานได้ถึง', until || '—']], { body: 'รับทราบการยกเลิกต่ออายุอัตโนมัติแล้ว คุณยังใช้บริการได้จนถึงวันที่ข้างต้น', ctaLabel: 'อัปเกรดใหม่' }),
    }).catch(() => {});
  }
});
// Owner self-service account close: deletes ALL tenant data (PDPA erasure). Requires slug
// confirmation to prevent accidental deletion. Clears the owner session cookie on success.
app.post('/api/owner/close-account', async (req, res) => {
  if (!SAAS) return res.status(404).json({ error: 'not_available' });
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const t = getTenant(req.tenantId);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const confirmSlug = String(req.body?.confirmSlug || '').trim().toLowerCase();
  if (!confirmSlug || confirmSlug !== t.slug) return res.status(400).json({ error: 'slug_mismatch' });
  const { owner_email: email, name } = t;
  logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'owner.close_account', detail: 'slug=' + t.slug, ip: ipOf(req) });
  try { deleteTenant(req.tenantId); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.setHeader('Set-Cookie', `sess=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURE}`);
  res.json({ ok: true });
  if (email) sendEmail({
    to: email, subject: `[ขายดี] บัญชีร้าน "${name}" ถูกปิดแล้ว`,
    text: `บัญชีร้าน "${name}" ถูกปิดและลบข้อมูลทั้งหมดแล้วตามคำขอ\nขอบคุณที่ใช้บริการ ขายดี KhaiDee\nหากต้องการเปิดร้านใหม่ สมัครได้ที่ ${BASE_URL}/signup/`,
    html: billingHtml(name, null, [], { body: `บัญชีร้าน <b>"${name}"</b> ถูกปิดและลบข้อมูลทั้งหมดแล้วตามคำขอ PDPA ขอบคุณที่ใช้บริการ ขายดี KhaiDee`, ctaLabel: 'เปิดร้านใหม่', ctaUrl: `${BASE_URL}/signup/` }),
  }).catch(() => {});
});
// Omise account-level webhook (one URL for the whole platform). Authenticity is verified by
// re-fetching the event from Omise inside billingWebhook; the tenant is found via the charge's
// customer, so no per-tenant routing is needed.
app.post('/billing/omise/webhook', async (req, res) => {
  try { await billingWebhook(req.body?.id); } catch { /* never error back to Omise */ }
  res.sendStatus(200);
});
app.post('/api/admin/brand', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });   // brand identity = owner only
  if (!SAAS) return res.status(400).json({ error: 'single_tenant_uses_env' });
  try {
    updateTenantBrand(req.tenantId, req.body || {});
    if (req.body?.about !== undefined) setSetting('brand:about', String(req.body.about || '').slice(0, 200));
    res.json({ ok: true, ...brandFor(req), about: getSetting('brand:about', '') || '' });
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// ---- Per-tenant LINE connect (Phase C). A Pkg-2 brand owner pastes their own Messaging API
// token/secret + LIFF id; stored in the tenant's settings. Secrets are write-only (never echoed).
// SaaS-only — single-tenant uses env. ----
app.get('/api/admin/line-config', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({
    saas: SAAS,
    configured: SAAS ? lineConfigured() : LINE_ENABLED,
    liffId: getSetting('liff:id', '') || '',
    addFriendUrl: getSetting('line:add_friend_url', '') || '',
    hasToken: !!(getSetting('line:token', '')),
    hasSecret: !!(getSetting('line:secret', '')),
    webhookUrl: `${PUBLIC_BASE_URL}/b/${(brandFor(req).slug || '')}/line/webhook`,
    liffEndpointUrl: `${PUBLIC_BASE_URL}/b/${(brandFor(req).slug || '')}/liff/`,
  });
});
app.post('/api/admin/line-config', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });   // integration tokens = owner only
  if (!SAAS) return res.status(400).json({ error: 'single_tenant_uses_env' });
  const b = req.body || {};
  const changed = [];
  if (b.token !== undefined) { setSetting('line:token', String(b.token || '').trim()); changed.push('token'); }
  if (b.secret !== undefined) { setSetting('line:secret', String(b.secret || '').trim()); changed.push('secret'); }
  if (b.liffId !== undefined) { setSetting('liff:id', String(b.liffId || '').trim()); changed.push('liff'); }
  if (b.addFriendUrl !== undefined) { setSetting('line:add_friend_url', String(b.addFriendUrl || '').trim()); changed.push('addFriend'); }
  if (changed.length) logAudit({ tenantId: req.tenantId, actor: ownerActor(req), action: 'line.config', detail: 'fields=' + changed.join(','), ip: ipOf(req) });   // log WHICH fields, never the values
  res.json({ ok: true, configured: lineConfigured(), liffId: getSetting('liff:id', '') || '' });
});
// Live-verify a pasted Messaging API token against LINE → confirms "connected to @yourshop" (the
// wizard's confidence signal). Owner-gated; no side effects.
app.post('/api/admin/line-verify', async (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(await verifyMessagingToken(req.body?.token));
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
    try { for (const z of db.prepare('SELECT z.id FROM zones z JOIN stores s ON s.id=z.store_id WHERE s.tenant_id=?').all(req.tenantId)) emit(z.id, 'update', (reveal) => Q.zoneSnapshot(z.id, { reveal })); } catch { /* refresh best-effort */ }
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
  if (!db.prepare('SELECT 1 FROM stores WHERE id=? AND tenant_id=?').get(req.params.storeId, req.tenantId)) return res.status(404).json({ error: 'store_not_found' });
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
  const lc = lineCfgFor(req);
  const url = lc.liffId
    ? `https://liff.line.me/${lc.liffId}?zone=${z.id}`
    : `${PUBLIC_BASE_URL}${req.tenantBase || ''}/liff/?zone=${z.id}`;
  try {
    const buf = await QRCode.toBuffer(url, { width: 600, margin: 1, color: { dark: '#16314f', light: '#ffffff' } });
    res.type('png').send(buf);
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
  if (posOnlyFor(req) || !SELF_ORDER) return res.status(404).json({ error: 'self_order_off' });
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
    const map = { zone_closed: 423, zone_not_found: 404, empty_order: 400, order_limit: 402 };
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
    let msg = `🎉 คุณได้รับ +${l.awarded} ดวง! สะสมรวม ${l.balance} ดวง\nสะสมครบแลกเครื่องดื่มฟรีได้เลยครับ`;
    if (l.tierUp) {
      msg += `\n\n🏅 ยินดีด้วย! คุณเลื่อนระดับเป็น ${l.tierUp.emoji} ${l.tierUp.label} แล้ว!`;
      if (l.tierUp.perk) msg += `\nสิทธิพิเศษ: ${l.tierUp.perk}`;
    }
    pushText(l.key, msg).catch(() => {});
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
  res.json(Q.dailyReport(req.query.branchId ? Number(req.query.branchId) : null));
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
  const r = Q.archiveTodaySales();
  res.json({ ok: true, saved: !!r });
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
  try { res.json(Q.createBranch(req.body || {})); } catch (e) { res.status(e.message === 'branch_limit' ? 402 : 400).json({ error: e.message }); }
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
    const stores = db.prepare('SELECT name FROM stores WHERE tenant_id=? ORDER BY id LIMIT 1').get(currentTenantId());
    const storeName = stores?.name || brandFor(req).name || BRAND.name;
    const buf = await buildReportWorkbook(Q.dailyReport(), { store: storeName });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const rSlug = storeName.replace(/[^a-z0-9]/gi, '_');
    res.set('Content-Disposition', `attachment; filename="${rSlug}_Report_${new Date().toISOString().slice(0,10)}.xlsx"`);
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
    const stores = db.prepare('SELECT name FROM stores WHERE tenant_id=? ORDER BY id LIMIT 1').get(currentTenantId());
    const storeName = stores?.name || brandFor(req).name || BRAND.name;
    const data = Q.detailedReports({ date, branchId });
    const buf = await buildDetailedWorkbook(data, { store: storeName, date: date || new Date().toISOString().slice(0, 10) });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const dSlug = storeName.replace(/[^a-z0-9]/gi, '_');
    res.set('Content-Disposition', `attachment; filename="${dSlug}_Detailed_${date || new Date().toISOString().slice(0,10)}.xlsx"`);
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
// Starter-menu templates: list the verticals, and one-tap pre-fill a sample menu (owner only).
app.get('/api/menu-templates', (req, res) => {
  if (!managerOK(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ templates: listTemplates() });
});
app.post('/api/admin/apply-template', (req, res) => {
  if (!ownerOK(req)) return res.status(403).json({ error: 'forbidden' });
  const items = templateItems(req.body?.template);
  if (!items) return res.status(400).json({ error: 'unknown_template' });
  let added = 0;
  for (const it of items) { try { Q.addMenuItem(it); added += 1; } catch { /* skip a bad row, keep going */ } }
  res.json({ ok: true, added });
});
app.post('/api/menu/:id', (req, res) => {
  if (!pinOK(req)) return res.status(401).json({ error: 'bad_pin' });
  try { const item = Q.updateMenuItem(req.params.id, req.body || {});
    if (req.body?.priceDelivery !== undefined) Q.setMenuDeliveryPrice(Number(req.params.id), req.body.priceDelivery);
    res.json(item); }
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
    // Optional combined "create + pay" in one request — the cashier picks the tender first, so we
    // skip a whole extra HTTP+DB round-trip (matters most on the remote-DB prod). Pay failure leaves
    // the order as a normal pending bill in "รอชำระเงิน". Both createOrder (by token) and setOrderPaid
    // are idempotent, so a retried request returns the same order — never a duplicate or double-charge.
    let paid = null;
    if (req.body?.pay) { try { paid = Q.setOrderPaid(r.ticket.id, { actorId, method: String(req.body.pay) }); } catch { /* stays pending */ } }
    emit(req.params.zoneId, 'update', (reveal) => Q.zoneSnapshot(req.params.zoneId, { reveal }));
    res.json({ ticketId: r.ticket.id, code: paid?.code || r.ticket.code, total: r.total, paid: !!paid, number: paid?.number || 0, idempotent: !!r.idempotent });
  } catch (e) {
    const map = { zone_closed: 423, zone_not_found: 404, empty_order: 400, order_limit: 402 };
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
  try {
    // Push end-of-day LINE summary to each owner BEFORE counters are wiped.
    const ended = db.prepare(`SELECT date('now','+7 hours','-1 day') AS d`).get().d;
    if (SAAS) {
      const REMIND_DAYS = new Set([1, 3, 7]);
      for (const t of listTenants()) {
        try { runWithTenant(t.id, () => { Q.archiveTodaySales(ended); Q.pushOwnerSummary(); }); } catch (_) { /* never block reset */ }
        // Trial / plan-expiry reminders: send at -7, -3, -1 days.
        try {
          const bs = billingStatus(t.id);
          if (bs.expiringSoon && REMIND_DAYS.has(bs.daysLeft)) {
            const d = bs.daysLeft;
            const msg = d === 1
              ? `🚨 แพ็กเกจ ${bs.plan.toUpperCase()} ของร้าน "${t.name}" หมดพรุ่งนี้ — อัปเกรดด่วนใน ⚙ ตั้งค่า เพื่อรักษา LINE และข้อมูลลูกค้าไว้`
              : `⚠️ แพ็กเกจ ${bs.plan.toUpperCase()} ของร้าน "${t.name}" จะหมดใน ${d} วัน — เข้า ⚙ ตั้งค่า > แพ็กเกจ เพื่ออัปเกรดและใช้งานต่อเนื่อง`;
            runWithTenant(t.id, () => Q.notifyOwner(msg));
          }
        } catch (_) { /* never block reset */ }
      }
      // Auto email-dunning sweep: send trial-expiry and lapsed emails (idempotent via dunning_log).
      const DUNNING_TMPLS = {
        trial_7d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" เหลือ 7 วัน`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro เหลือ 7 วัน กรุณาเพิ่มบัตรเครดิตเพื่อใช้งานต่อโดยไม่หยุดชะงัก`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>เหลือ 7 วัน</b> — เพิ่มบัตรเครดิตเพื่อใช้งานต่อโดยไม่หยุดชะงัก', ctaLabel: 'อัปเกรดเลย' }) }),
        trial_3d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" เหลือ 3 วัน`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro เหลือ 3 วัน เพิ่มบัตรเครดิตตอนนี้เพื่อไม่ให้บริการหยุดชะงัก`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>เหลือ 3 วัน</b> — เพิ่มบัตรเครดิตตอนนี้เพื่อไม่ให้บริการหยุดชะงัก', ctaLabel: 'อัปเกรดเลย' }) }),
        trial_1d: (c) => ({ subject: `[ขายดี] ทดลองใช้ "${c.name}" หมดพรุ่งนี้!`, text: `ร้าน "${c.name}" — ทดลองใช้ Pro หมดพรุ่งนี้! เพิ่มบัตรเครดิตด่วนเพื่อรักษา LINE และข้อมูลลูกค้า`, html: billingHtml(c.name, c.slug, [], { body: 'ทดลองใช้ Pro ของคุณ <b>จะหมดพรุ่งนี้</b>! เพิ่มบัตรเครดิตด่วนเพื่อรักษา LINE และข้อมูลลูกค้า', ctaLabel: 'อัปเกรดด่วน' }) }),
        lapsed:   (c) => ({ subject: `[ขายดี] แพ็กเกจ "${c.name}" หมดอายุแล้ว`, text: `ร้าน "${c.name}" กลับสู่โหมดฟรีแล้ว อัปเกรดเพื่อใช้ฟีเจอร์เต็มรูปแบบ`, html: billingHtml(c.name, c.slug, [], { body: 'แพ็กเกจของร้านคุณ<b>หมดอายุแล้ว</b> และกลับสู่โหมดฟรี — อัปเกรดเพื่อกลับมาใช้ LINE, รายงาน และฟีเจอร์ Pro ครบรูปแบบ', ctaLabel: 'อัปเกรดเลย' }) }),
      };
      // Fire-and-forget — doDailyReset is sync; email promises resolve independently.
      try {
        for (const c of getDunningCandidates()) {
          const tmpl = DUNNING_TMPLS[c.event]?.(c); if (!tmpl) continue;
          sendEmail({ to: c.email, ...tmpl })
            .then((r) => logDunningSend(c.tenantId, c.event, { dryRun: r.dryRun || false, toEmail: c.email }))
            .catch(() => {});
        }
      } catch (_) { /* never block reset */ }
    } else {
      try { Q.archiveTodaySales(ended); Q.pushOwnerSummary(); } catch (_) { /* never block reset */ }
    }
    let totalZones = 0;
    if (SAAS) {
      for (const t of listTenants()) {
        try {
          // Keep emit() inside runWithTenant so AsyncLocalStorage propagates into setImmediate.
          const zoneCount = runWithTenant(t.id, () => {
            const zoneIds = Q.resetAllZones();
            for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
            return zoneIds.length;
          });
          totalZones += zoneCount;
        } catch (_) { /* never block reset */ }
      }
    } else {
      const zoneIds = Q.resetAllZones();
      for (const id of zoneIds) emit(id, 'update', (reveal) => Q.zoneSnapshot(id, { reveal }));
      totalZones = zoneIds.length;
    }
    console.log(`[reset] queue reset to 0 for ${totalZones} zones`);
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
// Controlled by each tenant's "pending:void_min" setting (0 = off). Refreshes any zone it touches.
setInterval(() => {
  const sweep = () => { const r = Q.sweepStalePending(); if (r.voided > 0) for (const z of r.zones) emit(z, 'update', (reveal) => Q.zoneSnapshot(z, { reveal })); };
  try {
    if (SAAS) {
      for (const t of listTenants()) { try { runWithTenant(t.id, sweep); } catch { /* never crash */ } }
    } else {
      sweep();
    }
  } catch { /* never let the sweep crash the server */ }
}, 60 * 1000);

// Scheduled promo sweep: fire any promo whose send_at has arrived.
setInterval(async () => {
  try {
    const due = Q.duePromos();
    if (!due.length) return;
    const { multicastToCustomers } = await import('./line.js');
    for (const p of due) {
      try {
        const result = await multicastToCustomers(p.tenant_id, { message: p.message, imageUrl: p.image_url, linkUrl: p.link_url, linkLabel: p.link_label });
        Q.markPromoSent(p.id, { recipients: result.sent });
        console.log(`[promo] sent id=${p.id} tenant=${p.tenant_id} → ${result.sent} recipients`);
      } catch (e) {
        Q.markPromoFailed(p.id);
        console.error(`[promo] failed id=${p.id}:`, e.message);
      }
    }
  } catch { /* never crash the server */ }
}, 60 * 1000);

// Billing: recurring-charge sweep — renews pro tenants whose paid-through has passed (and
// downgrades after the grace window). Tenant-agnostic; only active when Omise is configured.
if (BILLING_ON) setInterval(async () => {
  try {
    const result = await renewDue();
    for (const r of (result.receipts || [])) {
      const planLabel = (r.plan === 'business' ? 'Business' : 'Pro') + ' ' + (r.interval === 'year' ? 'รายปี' : 'รายเดือน');
      const paid = '฿' + Math.round((r.amount || 0) / 100).toLocaleString('en-US');
      const until = r.planUntil ? new Date(r.planUntil).toLocaleDateString('th-TH') : '';
      sendEmail({ to: r.email, subject: `[ขายดี] ใบเสร็จต่ออายุ — ${planLabel}`,
        text: `ต่ออายุ ${planLabel} สำเร็จ\nยอดชำระ: ${paid}\nใช้งานได้ถึง: ${until}\n\nขายดี KhaiDee`,
        html: billingHtml(r.name, r.slug, [['แพ็กเกจ', planLabel], ['ยอดชำระ', paid], ['ใช้งานได้ถึง', until]], { body: `ต่ออายุ <b>${planLabel}</b> สำเร็จแล้ว`, ctaLabel: 'เข้าระบบเลย' }),
      }).catch(() => {});
    }
    for (const d of (result.downgrades || [])) {
      const prevLabel = d.prevPlan === 'business' ? 'Business' : 'Pro';
      sendEmail({ to: d.email, subject: `[ขายดี] แพ็กเกจ ${prevLabel} หมดอายุ — ร้านกลับสู่ Free`,
        text: `แพ็กเกจ ${prevLabel} ของคุณหมดอายุและไม่สามารถต่ออายุได้ ร้านยังใช้งานได้ในโหมด Free\nอัปเกรดได้ที่ ⚙ ตั้งค่า > แพ็กเกจ\n\nขายดี KhaiDee`,
        html: billingHtml(d.name, d.slug, [], { body: `แพ็กเกจ <b>${prevLabel}</b> ของร้านหมดอายุแล้ว — ร้านยังใช้งานได้ในโหมดฟรี อัปเกรดเพื่อกลับมาใช้ LINE, รายงาน และฟีเจอร์ครบรูปแบบ`, ctaLabel: 'อัปเกรดใหม่' }),
      }).catch(() => {});
    }
  } catch {}
}, 6 * 3600 * 1000);

// Hourly cleanup: purge expired password-reset tokens and stale in-memory rate-limit entries.
setInterval(() => {
  try { db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < datetime('now') OR used=1").run(); } catch {}
  try { db.prepare("DELETE FROM email_change_tokens WHERE expires_at < datetime('now') OR used=1").run(); } catch {}
  const now = Date.now();
  for (const [k, v] of ownerHits) { if (v.until < now) ownerHits.delete(k); }
  for (const [k, v] of forgotHits) { if (v.until < now) forgotHits.delete(k); }
}, 3600 * 1000);

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
else if (!DURABLE && !SAAS) {   // SaaS never auto-seeds the YO-DEE demo — tenants self-register
  try {
    const r = seedDemo();
    if (r.seeded) console.log(`[seed] Ephemeral boot — seeded demo store + ${r.drinks} drinks (UAT sandbox).`);
    // Loyalty rewards are exercised on the UAT sandbox only; prod stays OFF until the owner
    // flips it on in ⚙ จัดการ (seed default is '0', so a prod cutover never auto-enables it).
    Q.setLoyaltyEnabled(true);
    // Queue-first model is exercised on UAT only; prod stays pay-first (seed '0') until the owner
    // flips it on in ⚙ จัดการ after testing here.
    Q.setQueueFirst(true);
  } catch (e) { console.error('[seed] auto-seed skipped:', e.message); }
}

// 404 catch-all: JSON for /api/ paths, redirect everything else to the landing page.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.redirect('/landing/');
});

// Express error middleware — catches thrown errors in route handlers.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logAppError(err, { method: req.method, url: req.url });
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

process.on('uncaughtException', (err) => logAppError(err, { source: 'uncaughtException' }));
process.on('unhandledRejection', (reason) => logAppError(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' }));

app.listen(PORT, () => {
  console.log(`Mobile Queue running on ${PUBLIC_BASE_URL}`);
  console.log(`LINE: ${LINE_ENABLED ? 'ENABLED (real pushes)' : 'STUBBED (logs only — set LINE_* in .env to enable)'}`);
});

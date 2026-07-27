// LINE Messaging API wrapper.
// Degrades gracefully: if no LINE_CHANNEL_ACCESS_TOKEN is set, push messages are
// logged to the console instead of sent, so the whole system runs locally without
// any LINE account. No magic — when unconfigured it tells you so in the logs.
import * as line from '@line/bot-sdk';
import { db } from './db.js';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const secret = process.env.LINE_CHANNEL_SECRET || '';
export const LINE_ENABLED = Boolean(token && secret);

let client = null;
if (LINE_ENABLED) {
  client = new line.messagingApi.MessagingApiClient({ channelAccessToken: token });
}

export const lineMiddleware = LINE_ENABLED
  ? line.middleware({ channelSecret: secret })
  : (req, res, next) => next(); // no-op when not configured

/** Send a text push to a LINE user. Returns true if actually sent.
 *  `kind` tags the attempt in push_log (e.g. 'summary') so a silent failure is diagnosable
 *  later — before this, a failed owner summary left no trace anywhere the UI could show. */
export async function pushText(userId, text, kind = 'other') {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    _lastPushError = null;
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    // Keep WHAT LINE actually said. "ล้มเหลว" with no reason sent the owner guessing between four
    // very different causes (not a friend / id from another provider / expired token / quota).
    const status = err?.status || err?.statusCode || err?.originalError?.response?.status || null;
    const detail = err?.body?.message || err?.originalError?.response?.data?.message
      || err?.statusMessage || err?.message || String(err);
    _lastPushError = { status, detail: String(detail).slice(0, 300), at: new Date().toISOString() };
    console.error('[LINE] push failed:', status || '', detail);
    logPush(userId, kind, false);
    return false;
  }
}
let _lastPushError = null;
/** What LINE said about the most recent failed push (null once one succeeds). */
export function lastPushError() { return _lastPushError; }

// ---- Identity checks. A LINE userId belongs to ONE channel: an id captured from the test OA can
// never be pushed to from the real OA, and vice-versa. That mismatch is invisible from the outside
// (add-friend looks fine, the id looks well-formed) so these two read-only calls make it visible.
// The token itself is NEVER returned — only which OA it belongs to.
/** Which OA is this server's token actually for? → { basicId:'@138dccus', displayName, ... } */
export async function botInfo() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, basicId: body.basicId || null, displayName: body.displayName || null,
             userId: body.userId || null, premiumId: body.premiumId || null };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Is the OA's webhook set, switched on, and does LINE actually reach it? Typing "id" in the chat
 *  can only ever reply if all three are true — with webhook off, the message never leaves LINE. */
export async function webhookInfo() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, endpoint: body.endpoint || null, active: body.active === true };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Ask LINE to POST a test event to the configured webhook and report what came back. */
export async function webhookTest() {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/test',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', status: r.status, detail: body?.message || '' };
    return { ok: true, success: body.success === true, statusCode: body.statusCode ?? null,
             reason: body.reason || null, detail: body.detail || null };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}
/** Point the OA's webhook at this server. Owner-triggered only — it changes the LINE channel's
 *  own configuration, so it is never called automatically. */
export async function setWebhook(url) {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint',
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: url }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, detail: body?.message || '' };
    return { ok: true };
  } catch (e) { return { ok: false, detail: String(e?.message || e) }; }
}
/** Is this userId a friend of THIS channel? 404/403 = not this channel's user (or not a friend). */
export async function friendCheck(userId) {
  if (!LINE_ENABLED) return { ok: false, reason: 'line_off' };
  if (!userId) return { ok: false, reason: 'no_id' };
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, friend: true, displayName: body.displayName || null };
    return { ok: true, friend: false, status: r.status, detail: body?.message || '' };
  } catch (e) { return { ok: false, reason: 'network', detail: String(e?.message || e) }; }
}

/** Build a LINE message: a Flex card (text + a tappable button that hides the URL
 *  behind a label) when a link is given; otherwise a plain text message. */
function buildQueueMessage(text, link, label) {
  if (!link) return { type: 'text', text };
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return {
    type: 'flex',
    altText: lines[0] || 'อัปเดตคิว',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: lines.map((t, i) => ({
          type: 'text', text: t, wrap: true,
          size: i === 0 ? 'lg' : 'sm',
          weight: i === 0 ? 'bold' : 'regular',
          color: i === 0 ? '#1e3a5f' : '#555555',
        })),
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#1ab3ce', height: 'sm',
          action: { type: 'uri', label: label, uri: link },
        }],
      },
    },
  };
}

/** Order-status Flex card with a LINE-MAN-style progress bar. A LIFF web app cannot create an
 *  iOS Live Activity (that needs a native App Store app), so this is the closest equivalent:
 *  the lock screen shows the alt-text status line, and the chat shows a progress card.
 *  stage: 1 = รับออเดอร์แล้ว · 2 = กำลังทำ/ใกล้ถึงคิว · 3 = พร้อมรับ. Costs the SAME one message
 *  as the plain push it replaces. */
const STAGE_META = [
  { icon: '🧾', label: 'รับออเดอร์' },
  { icon: '🥤', label: 'กำลังทำ' },
  { icon: '🔔', label: 'พร้อมรับ' },
];
const ON = '#16a34a', OFF = '#d9e2e8', INK = '#1e3a5f', MUT = '#8a9aa8';
function buildStageMessage({ stage, title, subtitle, code, link, label }) {
  const seg = (i) => ({ type: 'box', layout: 'vertical', height: '4px', flex: 3, backgroundColor: i < stage ? ON : OFF, cornerRadius: '2px', contents: [{ type: 'filler' }] });
  const dot = (i) => ({
    type: 'box', layout: 'vertical', flex: 2, contents: [
      { type: 'text', text: STAGE_META[i].icon, align: 'center', size: i === stage - 1 ? 'md' : 'sm' },
      { type: 'text', text: STAGE_META[i].label, align: 'center', size: 'xxs', color: i < stage ? ON : MUT, weight: i === stage - 1 ? 'bold' : 'regular' },
    ],
  });
  return {
    type: 'flex',
    altText: `${STAGE_META[stage - 1].icon} ${title}${code ? ` · คิว ${code}` : ''}`,
    contents: {
      type: 'bubble', size: 'mega',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          {
            type: 'box', layout: 'horizontal', contents: [
              { type: 'text', text: title, weight: 'bold', size: 'lg', color: INK, wrap: true, flex: 5 },
              ...(code ? [{ type: 'text', text: code, weight: 'bold', size: 'lg', color: ON, align: 'end', flex: 2 }] : []),
            ],
          },
          ...(subtitle ? [{ type: 'text', text: subtitle, size: 'sm', color: '#555555', wrap: true }] : []),
          {
            type: 'box', layout: 'horizontal', alignItems: 'center', margin: 'md', contents: [
              dot(0), seg(1), dot(1), seg(2), dot(2),
            ],
          },
        ],
      },
      ...(link ? {
        footer: {
          type: 'box', layout: 'vertical',
          contents: [{ type: 'button', style: 'primary', color: '#1ab3ce', height: 'sm', action: { type: 'uri', label: label || 'ดูคิวของฉัน', uri: link } }],
        },
      } : {}),
    },
  };
}
/** Push an order-status progress card (falls back to plain text like pushQueue). */
export async function pushStage(userId, opts, kind = 'queue') {
  if (!userId) return false;
  const fallbackText = `${STAGE_META[(opts.stage || 1) - 1].icon} ${opts.title}${opts.code ? `\nหมายเลข: ${opts.code}` : ''}${opts.subtitle ? `\n${opts.subtitle}` : ''}`;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB stage${opts.stage}] -> ${userId}\n${fallbackText}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildStageMessage(opts)] });
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    console.error('[LINE] stage flex failed, falling back:', err?.statusMessage || err?.message || err);
    try {
      const t = opts.link ? `${fallbackText}\n\n👉 ${opts.link}` : fallbackText;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: t }] });
      logPush(userId, kind, true); return true;
    } catch (e) { logPush(userId, kind, false); return false; }
  }
}
// Every REAL push (LINE enabled) is counted in push_log — LINE OA bills by message volume, and
// before this the owner had no way to see how many messages a month the shop was paying for.
// The UAT stub is NOT logged (it costs nothing). Best-effort: logging never blocks a push.
function logPush(userId, kind, ok) {
  try { db.prepare('INSERT INTO push_log (user_id, kind, ok) VALUES (?,?,?)').run(userId || null, kind || 'other', ok ? 1 : 0); }
  catch { /* push_log may not exist on very old DBs */ }
}
/** Push a queue update with an optional "check queue" button (URL hidden behind it).
 *  Falls back to a plain-text message (with the link) if the card can't be sent.
 *  `kind` tags the message purpose for the monthly cost report (push_log). */
export async function pushQueue(userId, text, link = null, label = 'ดูคิวของฉัน', kind = 'other') {
  if (!userId) return false;
  if (!LINE_ENABLED) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}${link ? `\n[button: "${label}" -> ${link}]` : ''}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildQueueMessage(text, link, label)] });
    logPush(userId, kind, true);
    return true;
  } catch (err) {
    console.error('[LINE] flex push failed, falling back to text:', err?.statusMessage || err?.message || err);
    try {
      const fallback = link ? `${text}\n\n👉 ${link}` : text;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: fallback }] });
      logPush(userId, kind, true);
      return true;
    } catch (e) { logPush(userId, kind, false); return false; }
  }
}

/** Ask LINE who a LIFF access token really belongs to. Returns the userId, or null when the token
 *  is missing/expired/forged. This is the only proof of identity a claim can trust: the LINE id
 *  format itself is trivially fabricated, so a script could otherwise drain a campaign's quota
 *  with synthetic "customers". With LINE stubbed (UAT/dev) there is no LINE to ask — callers skip
 *  the check there, which also keeps local testing possible. */
export async function verifyLiffToken(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const p = await r.json();
    return p && p.userId ? p.userId : null;
  } catch { return null; }
}

/** Reply to a webhook event (used for follow / message events). */
export async function replyText(replyToken, text) {
  if (!LINE_ENABLED || !replyToken) return false;
  try {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('[LINE] reply failed:', err?.message || err);
    return false;
  }
}

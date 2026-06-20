// LINE Messaging API wrapper.
// Degrades gracefully: if no LINE_CHANNEL_ACCESS_TOKEN is set, push messages are
// logged to the console instead of sent, so the whole system runs locally without
// any LINE account. No magic — when unconfigured it tells you so in the logs.
import * as line from '@line/bot-sdk';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSetting } from './db.js';
import { currentTenantId } from './tenant.js';

const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const envSecret = process.env.LINE_CHANNEL_SECRET || '';
// Whether the SINGLE-TENANT (tenant 1) instance has LINE via env. Per-tenant SaaS brands
// configure their own tokens in settings (see lineCredsFor / lineConfigured).
export const LINE_ENABLED = Boolean(envToken && envSecret);

// Resolve a tenant's LINE credentials: tenant 1 uses env (unchanged); other tenants read the
// tokens they pasted in their settings. Returns { token, secret }.
export function lineCredsFor(tenantId = currentTenantId()) {
  if (tenantId === 1) return { token: envToken, secret: envSecret };
  return { token: getSetting('line:token', '', tenantId) || '', secret: getSetting('line:secret', '', tenantId) || '' };
}
/** Is LINE configured for the active tenant? */
export function lineConfigured(tenantId = currentTenantId()) {
  return Boolean(lineCredsFor(tenantId).token && lineCredsFor(tenantId).secret);
}

// Cache one MessagingApiClient per access token (creating one per push is wasteful).
const clientCache = new Map();
function clientFor(tenantId = currentTenantId()) {
  const { token } = lineCredsFor(tenantId);
  if (!token) return null;
  if (!clientCache.has(token)) clientCache.set(token, new line.messagingApi.MessagingApiClient({ channelAccessToken: token }));
  return clientCache.get(token);
}

// Manual webhook signature verification (the SDK middleware is bound to one fixed secret; we
// need the ACTIVE tenant's secret). Verifies x-line-signature against the raw body + returns 401
// on mismatch. Single-tenant with no LINE configured is a pass-through (no-op).
export function lineMiddleware(req, res, next) {
  const { secret } = lineCredsFor();
  if (!secret) return next();                       // not configured for this tenant → no-op
  const sig = req.get('x-line-signature') || '';
  const raw = req.rawBody || (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0));
  try {
    const expected = createHmac('SHA256', secret).update(raw).digest('base64');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.sendStatus(401);
  } catch { return res.sendStatus(401); }
  next();
}

/** Send a text push to a LINE user. Returns true if actually sent. */
export async function pushText(userId, text) {
  if (!userId) return false;
  const client = clientFor();
  if (!client) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('[LINE] push failed:', err?.statusMessage || err?.message || err);
    return false;
  }
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

/** Push a queue update with an optional "check queue" button (URL hidden behind it).
 *  Falls back to a plain-text message (with the link) if the card can't be sent. */
export async function pushQueue(userId, text, link = null, label = 'ดูคิวของฉัน') {
  if (!userId) return false;
  const client = clientFor();
  if (!client) {
    console.log(`\n[LINE-STUB] -> ${userId}\n${text}${link ? `\n[button: "${label}" -> ${link}]` : ''}\n`);
    return false;
  }
  try {
    await client.pushMessage({ to: userId, messages: [buildQueueMessage(text, link, label)] });
    return true;
  } catch (err) {
    console.error('[LINE] flex push failed, falling back to text:', err?.statusMessage || err?.message || err);
    try {
      const fallback = link ? `${text}\n\n👉 ${link}` : text;
      await client.pushMessage({ to: userId, messages: [{ type: 'text', text: fallback }] });
      return true;
    } catch (e) { return false; }
  }
}

/** Reply to a webhook event (used for follow / message events). */
export async function replyText(replyToken, text) {
  if (!replyToken) return false;
  const client = clientFor();
  if (!client) return false;
  try {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
    return true;
  } catch (err) {
    console.error('[LINE] reply failed:', err?.message || err);
    return false;
  }
}

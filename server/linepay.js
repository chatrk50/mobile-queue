// LINE Pay (online) — SCAFFOLD, disabled until credentials are provided.
// Requires a LINE Pay MERCHANT account (a personal LINE Pay wallet cannot ACCEPT payments):
//   LINEPAY_CHANNEL_ID, LINEPAY_CHANNEL_SECRET  (from the LINE Pay merchant centre)
//   LINEPAY_ENV=production  -> live; anything else -> sandbox (for UAT)
// Until both env vars are set, LINEPAY_ON is false and every route degrades to "off".
import crypto from 'node:crypto';

const CHANNEL_ID = (process.env.LINEPAY_CHANNEL_ID || '').trim();
const CHANNEL_SECRET = (process.env.LINEPAY_CHANNEL_SECRET || '').trim();
export const LINEPAY_ON = Boolean(CHANNEL_ID && CHANNEL_SECRET);
const BASE = process.env.LINEPAY_ENV === 'production'
  ? 'https://api-pay.line.me'
  : 'https://sandbox-api-pay.line.me';

// LINE Pay v3 HMAC: Base64( HMAC-SHA256(secret, secret + uri + body + nonce) ).
function sign(uri, bodyStr, nonce) {
  return crypto.createHmac('sha256', CHANNEL_SECRET).update(CHANNEL_SECRET + uri + bodyStr + nonce).digest('base64');
}
async function call(method, uri, bodyObj) {
  const nonce = crypto.randomUUID();
  const bodyStr = method === 'GET' ? '' : JSON.stringify(bodyObj || {});
  const res = await fetch(BASE + uri, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-LINE-ChannelId': CHANNEL_ID,
      'X-LINE-Authorization-Nonce': nonce,
      'X-LINE-Authorization': sign(uri, bodyStr, nonce),
    },
    body: method === 'GET' ? undefined : bodyStr,
  });
  return res.json();
}

/** Reserve a payment → returns { ok, transactionId, paymentUrl } (web URL to redirect the customer to). */
export async function reserve({ amount, orderId, productName, confirmUrl, cancelUrl }) {
  if (!LINEPAY_ON) throw new Error('linepay_off');
  const body = {
    amount, currency: 'THB', orderId: String(orderId),
    packages: [{ id: 'pkg1', amount, products: [{ name: productName || 'Order', quantity: 1, price: amount }] }],
    redirectUrls: { confirmUrl, cancelUrl },
  };
  const j = await call('POST', '/v3/payments/request', body);
  if (j.returnCode !== '0000') return { ok: false, code: j.returnCode, message: j.returnMessage };
  return { ok: true, transactionId: j.info.transactionId, paymentUrl: j.info.paymentUrl?.web || j.info.paymentUrl?.app };
}

/** Confirm a payment after the customer returns from LINE Pay. */
export async function confirm(transactionId, amount) {
  if (!LINEPAY_ON) throw new Error('linepay_off');
  const j = await call('POST', `/v3/payments/${transactionId}/confirm`, { amount, currency: 'THB' });
  return { ok: j.returnCode === '0000', code: j.returnCode, message: j.returnMessage, info: j.info };
}

// Self-service billing via Omise (Opn Payments) — monthly Pro subscription.
// Card data NEVER touches this server: the browser tokenises the card with Omise.js (public key)
// and sends only a one-time token here; we charge it server-side with the secret key. Degrades
// gracefully when unconfigured (BILLING_ON=false) → the UI falls back to manual upgrades.
import { db } from './db.js';

const SECRET = (process.env.OMISE_SECRET_KEY || '').trim();   // skey_… (server only, secret)
const PUBLIC = (process.env.OMISE_PUBLIC_KEY || '').trim();   // pkey_… (client, not secret)
export const BILLING_ON = Boolean(SECRET && PUBLIC);
const AMOUNT = Math.max(2000, parseInt(process.env.OMISE_PRO_AMOUNT || '29900', 10) || 29900); // satang (default ฿299)
const CURRENCY = (process.env.OMISE_CURRENCY || 'thb').toLowerCase();
const GRACE_MS = 3 * 24 * 3600 * 1000;

export function billingConfig() { return { configured: BILLING_ON, publicKey: PUBLIC, amount: AMOUNT, currency: CURRENCY }; }

function form(obj) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v != null && v !== '') p.append(k, String(v)); return p.toString(); }
async function omise(method, path, body) {
  const res = await fetch(`https://api.omise.co${path}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(SECRET + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.object === 'error') throw new Error('omise:' + (data.code || data.message || res.status));
  return data;
}
// add one calendar month to a UTC ISO datetime (or now). (Plain Date — server code, not a workflow.)
function addMonth(fromIso) { const d = fromIso ? new Date(fromIso) : new Date(); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); }
function setPro(tenantId, untilIso, customerId) {
  db.prepare('UPDATE tenants SET plan_name=?, plan_until=?, auto_renew=1, omise_customer_id=COALESCE(?,omise_customer_id) WHERE id=?')
    .run('pro', untilIso, customerId || null, tenantId);
}

export function billingStatus(tenantId) {
  const t = db.prepare('SELECT plan_name, plan_until, auto_renew, omise_customer_id FROM tenants WHERE id=?').get(tenantId) || {};
  return { ...billingConfig(), plan: t.plan_name || 'free', planUntil: t.plan_until || null, autoRenew: !!t.auto_renew, hasCard: !!t.omise_customer_id };
}

/** Subscribe a tenant to Pro: save the card on an Omise customer, charge the first month now,
 *  and set plan=pro paid-through +1 month with auto-renew on. Throws on a declined card. */
export async function subscribeTenant(tenantId, token, email = null) {
  if (!BILLING_ON) throw new Error('billing_off');
  if (!token) throw new Error('token_required');
  const cur = db.prepare('SELECT omise_customer_id FROM tenants WHERE id=?').get(tenantId);
  let customerId = cur && cur.omise_customer_id;
  if (customerId) await omise('PATCH', `/customers/${customerId}`, { card: token });
  else customerId = (await omise('POST', '/customers', { email, card: token })).id;
  const charge = await omise('POST', '/charges', { amount: AMOUNT, currency: CURRENCY, customer: customerId, description: 'Pro subscription (1 month)' });
  if (!charge.paid) throw new Error('charge_failed');
  const until = addMonth();
  setPro(tenantId, until, customerId);
  return { ok: true, planUntil: until };
}

/** Cancel auto-renew. Pro stays active until plan_until, then lapses to free. */
export function cancelSubscription(tenantId) {
  db.prepare('UPDATE tenants SET auto_renew=0 WHERE id=?').run(tenantId);
  return billingStatus(tenantId);
}

/** Renewal sweep — charge every pro tenant whose paid-through has passed; extend on success,
 *  downgrade to free once >3 days past due. Idempotent (only charges the actually-due). */
export async function renewDue() {
  if (!BILLING_ON) return { charged: 0, failed: 0, skipped: 'billing_off' };
  const nowIso = new Date().toISOString();
  const due = db.prepare(`SELECT id, omise_customer_id, plan_until FROM tenants
    WHERE plan_name='pro' AND auto_renew=1 AND omise_customer_id IS NOT NULL AND (plan_until IS NULL OR plan_until <= ?)`).all(nowIso);
  let charged = 0, failed = 0;
  for (const t of due) {
    try {
      const ch = await omise('POST', '/charges', { amount: AMOUNT, currency: CURRENCY, customer: t.omise_customer_id, description: 'Pro renewal' });
      if (!ch.paid) throw new Error('not_paid');
      setPro(t.id, addMonth(t.plan_until && t.plan_until > nowIso ? t.plan_until : nowIso), t.omise_customer_id);
      charged++;
    } catch (e) {
      failed++;
      const graceCut = new Date(Date.now() - GRACE_MS).toISOString();
      if (!t.plan_until || t.plan_until < graceCut) db.prepare("UPDATE tenants SET plan_name='free', auto_renew=0 WHERE id=?").run(t.id);
    }
  }
  return { charged, failed };
}

/** Apply a (verified) Omise event to a tenant — mainly to downgrade on a refund. Exported pure
 *  so it can be unit-tested with a fake event. Returns the action taken. */
export function applyEvent(ev) {
  const key = ev && ev.key, data = (ev && ev.data) || {};
  const custId = typeof data.customer === 'string' ? data.customer : (data.customer && data.customer.id);
  if (key === 'refund.create' && custId) {
    const t = db.prepare('SELECT id FROM tenants WHERE omise_customer_id=?').get(custId);
    if (t) { db.prepare("UPDATE tenants SET plan_name='free', auto_renew=0 WHERE id=?").run(t.id); return { action: 'downgrade', tenantId: t.id }; }
  }
  return { action: 'none', key };
}
/** Webhook entrypoint: re-fetch the event from Omise (authenticity check) then apply it. */
export async function handleWebhook(eventId) {
  if (!BILLING_ON || !eventId) return { ok: false };
  const ev = await omise('GET', `/events/${eventId}`);
  return { ok: true, ...applyEvent(ev) };
}

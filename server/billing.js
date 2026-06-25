// Self-service billing via Omise (Opn Payments) — monthly Pro subscription.
// Card data NEVER touches this server: the browser tokenises the card with Omise.js (public key)
// and sends only a one-time token here; we charge it server-side with the secret key. Degrades
// gracefully when unconfigured (BILLING_ON=false) → the UI falls back to manual upgrades.
import { db } from './db.js';

const SECRET = (process.env.OMISE_SECRET_KEY || '').trim();   // skey_… (server only, secret)
const PUBLIC = (process.env.OMISE_PUBLIC_KEY || '').trim();   // pkey_… (client, not secret)
export const BILLING_ON = Boolean(SECRET && PUBLIC);
const CURRENCY = (process.env.OMISE_CURRENCY || 'thb').toLowerCase();
const GRACE_MS = 3 * 24 * 3600 * 1000;
// Price per plan × interval, in satang. Defaults: Pro ฿299/mo · ฿2,990/yr · Business ฿799/mo · ฿7,990/yr.
const sat = (env, def) => Math.max(2000, parseInt(process.env[env] || String(def), 10) || def);
const PRICES = {
  pro:      { month: sat('OMISE_PRO_AMOUNT', 29900), year: sat('OMISE_PRO_YEAR', 299000) },
  business: { month: sat('OMISE_BIZ_AMOUNT', 79900), year: sat('OMISE_BIZ_YEAR', 799000) },
};
const FOUNDER = { month: sat('OMISE_FOUNDER_AMOUNT', 19900), year: sat('OMISE_FOUNDER_YEAR', 199000) }; // first-N lock-in (Pro)
const normPlan = (p) => (p === 'business' ? 'business' : 'pro');
const normInterval = (i) => (i === 'year' ? 'year' : 'month');
function priceOf(plan, interval) { return PRICES[normPlan(plan)][normInterval(interval)]; }
// Founders keep a discounted Pro price for life (Business is full price).
function priceForTenant(tenantId, plan, interval) {
  const t = db.prepare('SELECT founder FROM tenants WHERE id=?').get(tenantId);
  return (t && t.founder && normPlan(plan) === 'pro') ? FOUNDER[normInterval(interval)] : priceOf(plan, interval);
}

export function billingConfig() { return { configured: BILLING_ON, publicKey: PUBLIC, currency: CURRENCY, prices: PRICES }; }

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
// add one billing period to a UTC ISO datetime (or now). (Plain Date — server code, not a workflow.)
function addPeriod(fromIso, interval) {
  const d = fromIso ? new Date(fromIso) : new Date();
  if (normInterval(interval) === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}
function setPlan(tenantId, plan, untilIso, interval, customerId) {
  db.prepare('UPDATE tenants SET plan_name=?, plan_until=?, plan_interval=?, auto_renew=1, omise_customer_id=COALESCE(?,omise_customer_id) WHERE id=?')
    .run(normPlan(plan), untilIso, normInterval(interval), customerId || null, tenantId);
}

export function billingStatus(tenantId) {
  const t = db.prepare('SELECT plan_name, plan_until, plan_interval, auto_renew, omise_customer_id, founder, referral_code FROM tenants WHERE id=?').get(tenantId) || {};
  const hasCard = !!t.omise_customer_id, plan = t.plan_name || 'free';
  const cfg = billingConfig();
  // Founders see their discounted Pro price. Trial = on a paid plan but no saved card yet.
  if (t.founder) cfg.prices = { ...cfg.prices, pro: FOUNDER };
  const trial = plan !== 'free' && !hasCard;
  // Dunning nudge: paid plan ending within 7 days and won't auto-renew (trial ending / cancelled).
  const daysLeft = t.plan_until ? Math.ceil((new Date(t.plan_until).getTime() - Date.now()) / 86400000) : null;
  const expiringSoon = plan !== 'free' && daysLeft != null && daysLeft <= 7 && (trial || !t.auto_renew);
  return { ...cfg, plan, interval: t.plan_interval || 'month', planUntil: t.plan_until || null, daysLeft,
    autoRenew: !!t.auto_renew, hasCard, trial, expiringSoon, founder: !!t.founder, referralCode: t.referral_code || null };
}

/** Subscribe a tenant to a plan (pro|business) on an interval (month|year): save the card on an
 *  Omise customer, charge the first period now, set plan paid-through with auto-renew. Throws on
 *  a declined card. */
export async function subscribeTenant(tenantId, token, { plan = 'pro', interval = 'month', email = null } = {}) {
  if (!BILLING_ON) throw new Error('billing_off');
  if (!token) throw new Error('token_required');
  plan = normPlan(plan); interval = normInterval(interval);
  const amount = priceForTenant(tenantId, plan, interval);
  const cur = db.prepare('SELECT omise_customer_id FROM tenants WHERE id=?').get(tenantId);
  let customerId = cur && cur.omise_customer_id;
  if (customerId) await omise('PATCH', `/customers/${customerId}`, { card: token });
  else customerId = (await omise('POST', '/customers', { email, card: token })).id;
  const charge = await omise('POST', '/charges', { amount, currency: CURRENCY, customer: customerId, description: `${plan} subscription (1 ${interval})` });
  if (!charge.paid) throw new Error('charge_failed');
  const until = addPeriod(null, interval);
  setPlan(tenantId, plan, until, interval, customerId);
  return { ok: true, plan, interval, planUntil: until };
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
  const due = db.prepare(`SELECT id, omise_customer_id, plan_name, plan_interval, plan_until FROM tenants
    WHERE plan_name IN ('pro','business') AND auto_renew=1 AND omise_customer_id IS NOT NULL AND (plan_until IS NULL OR plan_until <= ?)`).all(nowIso);
  let charged = 0, failed = 0;
  for (const t of due) {
    try {
      const amount = priceForTenant(t.id, t.plan_name, t.plan_interval);
      const ch = await omise('POST', '/charges', { amount, currency: CURRENCY, customer: t.omise_customer_id, description: `${t.plan_name} renewal` });
      if (!ch.paid) throw new Error('not_paid');
      setPlan(t.id, t.plan_name, addPeriod(t.plan_until && t.plan_until > nowIso ? t.plan_until : nowIso, t.plan_interval), t.plan_interval, t.omise_customer_id);
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

// ---------- Dunning email scaffolding ----------

/** Return tenants that need a dunning email, with the event type and suggested message. */
export function getDunningCandidates() {
  const now = Date.now();
  const sent = new Set(
    db.prepare('SELECT tenant_id||":"||event k FROM dunning_log').all().map((r) => r.k)
  );
  const tenants = db.prepare(
    `SELECT id, name, owner_email, plan_name, plan_until, auto_renew, omise_customer_id
     FROM tenants WHERE id>1 AND active=1`
  ).all();

  const candidates = [];
  for (const t of tenants) {
    if (!t.owner_email) continue;
    const msLeft = t.plan_until ? new Date(t.plan_until).getTime() - now : null;
    const daysLeft = msLeft != null ? Math.ceil(msLeft / 86400000) : null;
    const isFree = t.plan_name === 'free';
    const hasCard = Boolean(t.omise_customer_id);

    // Trial/plan ending warnings (only when NOT auto-renewing or no card on file).
    if (!isFree && daysLeft != null && (!t.auto_renew || !hasCard)) {
      for (const [event, maxDays, minDays] of [
        ['trial_7d', 8, 4],
        ['trial_3d', 4, 1],
        ['trial_1d', 2, 0],
      ]) {
        if (daysLeft <= maxDays && daysLeft >= minDays && !sent.has(`${t.id}:${event}`)) {
          candidates.push({ tenantId: t.id, name: t.name, email: t.owner_email, event, daysLeft, plan: t.plan_name });
        }
      }
    }

    // Lapsed: was paid, now free (plan_until in the past).
    if (isFree && t.plan_until && new Date(t.plan_until).getTime() < now && !sent.has(`${t.id}:lapsed`)) {
      candidates.push({ tenantId: t.id, name: t.name, email: t.owner_email, event: 'lapsed', daysLeft: 0, plan: 'free' });
    }
  }
  return candidates;
}

/** Mark a dunning event as sent (or dry-run) to prevent duplicates. */
export function logDunningSend(tenantId, event, { dryRun = false, toEmail = null } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO dunning_log (tenant_id, event, dry_run, to_email, sent_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(tenantId, event, dryRun ? 1 : 0, toEmail);
}

/** Reset dunning log for a tenant (e.g. on plan renewal — allow fresh dunning cycle). */
export function clearDunningLog(tenantId) {
  db.prepare('DELETE FROM dunning_log WHERE tenant_id=?').run(tenantId);
}

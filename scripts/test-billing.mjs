// Billing logic that's testable WITHOUT Omise keys: graceful-off behaviour, plan expiry/grace,
// cancel, and the refund→downgrade event handler. (Live card charges need Omise test keys.)
import * as DB from '../server/db.js';
import * as Q from '../server/queue.js';
import * as B from '../server/billing.js';
import { runWithTenant } from '../server/tenant.js';
import { db } from '../server/db.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

ok(B.BILLING_ON === false, 'BILLING_ON is false without Omise keys (graceful)');
const st = B.billingStatus(1);
ok(st.configured === false && st.plan === 'free', 'billingStatus: not configured, default free');

// subscribe with no keys → billing_off
let threw = false;
try { await B.subscribeTenant(1, 'tokn_x'); } catch (e) { threw = e.message === 'billing_off'; }
ok(threw, 'subscribeTenant throws billing_off when unconfigured');

// Plan expiry / grace via tenantPlan.
const t = DB.createTenant({ name: 'Bill Co', pkg: 'pos' });
const future = new Date(Date.now() + 5 * 86400000).toISOString();
const wayPast = new Date(Date.now() - 10 * 86400000).toISOString();
const inGrace = new Date(Date.now() - 1 * 86400000).toISOString();
db.prepare("UPDATE tenants SET plan_name='pro', plan_until=? WHERE id=?").run(future, t.id);
ok(Q.tenantPlan(t.id).name === 'pro', 'pro with future paid-through → pro');
db.prepare('UPDATE tenants SET plan_until=? WHERE id=?').run(inGrace, t.id);
ok(Q.tenantPlan(t.id).name === 'pro', 'pro 1 day past due (within 3-day grace) → still pro');
db.prepare('UPDATE tenants SET plan_until=? WHERE id=?').run(wayPast, t.id);
ok(Q.tenantPlan(t.id).name === 'free', 'pro 10 days past due → lapses to free');

// Quota follows the effective plan: lapsed pro is treated as free (branch limit applies).
// Quota is only enforced in SaaS mode, so this assertion needs SAAS=1.
if (process.env.SAAS === '1') {
  db.prepare("UPDATE tenants SET plan_name='pro', plan_until=? WHERE id=?").run(wayPast, t.id);
  let limited = false;
  runWithTenant(t.id, () => { try { Q.createBranch({ name: 'A' }); Q.createBranch({ name: 'B' }); } catch (e) { limited = e.message === 'branch_limit'; } });
  ok(limited, 'lapsed-pro tenant is quota-limited like free (branch_limit on 2nd branch)');
} else {
  console.log('  SKIP: quota assertion (run with SAAS=1 to exercise)');
}

// cancelSubscription turns off auto-renew (keeps plan).
db.prepare("UPDATE tenants SET plan_name='pro', plan_until=?, auto_renew=1 WHERE id=?").run(future, t.id);
B.cancelSubscription(t.id);
ok(db.prepare('SELECT auto_renew FROM tenants WHERE id=?').get(t.id).auto_renew === 0, 'cancelSubscription clears auto_renew (plan kept)');

// applyEvent: a refund for a tenant's saved card downgrades that tenant.
db.prepare("UPDATE tenants SET plan_name='pro', plan_until=?, omise_customer_id='cus_test' WHERE id=?").run(future, t.id);
const r = B.applyEvent({ key: 'refund.create', data: { customer: 'cus_test' } });
ok(r.action === 'downgrade' && r.tenantId === t.id, 'applyEvent(refund) downgrades the matching tenant');
ok(Q.tenantPlan(t.id).name === 'free', 'tenant is free after refund');
// unrelated event = no-op
ok(B.applyEvent({ key: 'charge.complete', data: {} }).action === 'none', 'unrelated event → no action');

console.log(`\n${fail ? '❌' : '✅'} billing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Full ROLE-HIERARCHY + adversarial verification against a live SaaS server (boot SAAS=1 first).
// Covers: platform admin · customer admin (owner) · manager · cashier · end-customer · package
// gating · plan/quota · cross-tenant · and the closed global-PIN backdoor.
const BASE = process.env.BASE || 'http://localhost:4633';
const ADMIN = process.env.SAAS_ADMIN_PIN || 'adminsecret';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const sec = (t) => console.log('\n— ' + t + ' —');

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (cookie) h.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}
const anon = () => client();
async function brand(name, pkg, pin) {
  const c = client();
  const su = await c('POST', '/api/signup', { name, package: pkg, pin });
  const slug = su.data.slug;
  await c('POST', `/b/${slug}/api/staff/login`, { pin });
  const store = (await c('GET', `/b/${slug}/api/stores`)).data[0];
  const zoneId = (await c('GET', `/b/${slug}/api/stores/${store.id}/zones`)).data[0].id;
  return { c, slug, storeId: store.id, zoneId };
}

(async () => {
  console.log('Hierarchy + adversarial verification @ ' + BASE);

  // ===== Customer admin (owner) creates staff =====
  sec('Customer admin (owner) + staff provisioning');
  const A = await brand('Acme Tea', 'line', '1111');
  const mk = await A.c('POST', `/b/${A.slug}/api/staff`, { name: 'Mgr', pin: '2222', role: 'manager', branchIds: [A.storeId] });
  const ck = await A.c('POST', `/b/${A.slug}/api/staff`, { name: 'Csh', pin: '3333', role: 'cashier', branchIds: [A.storeId] });
  ok(mk.status === 200 && ck.status === 200, 'owner can create manager + cashier staff');
  const M = client(); await M('POST', `/b/${A.slug}/api/staff/login`, { pin: '2222' });
  const C = client(); await C('POST', `/b/${A.slug}/api/staff/login`, { pin: '3333' });

  // ===== Owner CAN customize (brand/menu/billing/line) =====
  sec('Owner capabilities');
  ok((await A.c('POST', `/b/${A.slug}/api/admin/brand`, { name: 'Acme Tea', unit: 'แก้ว' })).status === 200, 'owner edits brand');
  ok((await A.c('POST', `/b/${A.slug}/api/menu`, { name: 'Tea', price: 40 })).status === 200, 'owner adds menu');
  ok((await A.c('GET', `/b/${A.slug}/api/billing/status`)).status === 200, 'owner sees billing');
  ok((await A.c('POST', `/b/${A.slug}/api/admin/line-config`, { liffId: 'x-1' })).status === 200, 'owner sets LINE config');

  // ===== Cashier: can sell, CANNOT manage =====
  sec('Cashier role boundary');
  ok((await C('POST', `/b/${A.slug}/api/menu`, { name: 'Cup', price: 10 })).status === 200, 'cashier can add menu (pinOK)');
  ok((await C('POST', `/b/${A.slug}/api/zones/${A.zoneId}/orders`, { items: [{ name: 'Tea', price: 40, qty: 1 }] })).status === 200, 'cashier can take an order');
  ok((await C('GET', `/b/${A.slug}/api/report`)).status === 403, 'cashier CANNOT see reports (managerOK)');
  ok((await C('POST', `/b/${A.slug}/api/branches`, { name: 'X' })).status === 403, 'cashier CANNOT add a branch (ownerOK)');
  ok((await C('POST', `/b/${A.slug}/api/staff`, { name: 'Y', pin: '9988', role: 'cashier' })).status === 403, 'cashier CANNOT create staff');
  ok((await C('POST', `/b/${A.slug}/api/admin/brand`, { name: 'hack' })).status === 403, 'cashier CANNOT edit brand');
  ok((await C('POST', `/b/${A.slug}/api/billing/subscribe`, { token: 'x' })).status === 403, 'cashier CANNOT subscribe/pay (403 before billing check)');

  // ===== Manager: reports yes, owner-only no =====
  sec('Manager role boundary');
  ok((await M('GET', `/b/${A.slug}/api/report`)).status === 200, 'manager CAN see reports');
  ok((await M('POST', `/b/${A.slug}/api/branches`, { name: 'X' })).status === 403, 'manager CANNOT add a branch (ownerOK)');
  ok((await M('POST', `/b/${A.slug}/api/staff`, { name: 'Y', pin: '9977', role: 'cashier' })).status === 403, 'manager CANNOT create staff');

  // ===== CRITICAL: legacy global-PIN backdoor must be CLOSED in SaaS =====
  sec('Global-PIN backdoor (must be closed)');
  const x = anon();
  ok((await x('POST', `/b/${A.slug}/api/menu`, { name: 'z', price: 1 }, { 'x-cashier-pin': '1234' })).status === 401, 'raw x-cashier-pin:1234 → 401 (no global cashier backdoor)');
  ok((await x('GET', `/b/${A.slug}/api/report?pin=1234`)).status === 403, 'raw ?pin=1234 → 403 (no global manager backdoor)');
  ok((await x('POST', `/b/${A.slug}/api/branches`, { name: 'z', pin: '1234' })).status === 403, 'raw body pin:1234 → 403 (no global owner backdoor)');
  ok((await x('POST', `/b/${A.slug}/api/menu`, { name: 'z', price: 1 })).status === 401, 'no auth at all → 401');

  // ===== Platform admin separation =====
  sec('Platform admin separation');
  ok((await x('GET', '/admin/api/tenants')).status === 401, 'no admin PIN → 401');
  ok((await x('GET', '/admin/api/tenants', null, { 'x-admin-pin': '1111' })).status === 401, "a tenant owner's PIN does NOT grant platform admin");
  ok((await x('GET', '/admin/api/tenants', null, { 'x-admin-pin': ADMIN })).status === 200, 'correct SAAS_ADMIN_PIN → admin access');

  // ===== Cross-tenant: A's people cannot touch B =====
  sec('Cross-tenant isolation (sessions)');
  const B = await brand('Beta Cafe', 'pos', '4444');
  ok((await A.c('GET', `/b/${B.slug}/api/report`)).status === 403, "A's owner session cannot read B's report");
  ok((await A.c('POST', `/b/${B.slug}/api/menu`, { name: 'z', price: 1 })).status === 401, "A's owner session cannot add menu to B");

  // ===== Package gating (customize by subscription package) =====
  sec('Package gating');
  const aCfg = (await A.c('GET', `/b/${A.slug}/api/config`)).data;
  const bCfg = (await B.c('GET', `/b/${B.slug}/api/config`)).data;
  ok(aCfg.lineFeatures === true && aCfg.posOnly === false, 'LINE package → lineFeatures on');
  ok(bCfg.posOnly === true && bCfg.selfOrder === false, 'POS package → posOnly, self-order off');
  ok((await anon()('POST', `/b/${B.slug}/api/zones/1/order`, { items: [{ name: 'x', price: 1 }] })).status === 404, 'POS package → customer self-order endpoint 404');

  // ===== Plan / quota (free vs pro) =====
  sec('Plan & quota');
  const usage = (await A.c('GET', `/b/${A.slug}/api/admin/usage`)).data;
  ok(usage.plan === 'free' && usage.maxBranches === 1, 'free plan: 1-branch cap reported');
  ok((await A.c('POST', `/b/${A.slug}/api/branches`, { name: 'Branch 2' })).data?.error === 'branch_limit', 'free plan: 2nd branch blocked (branch_limit)');
  const adm = client();
  const aid = (await adm('GET', '/admin/api/tenants', null, { 'x-admin-pin': ADMIN })).data.tenants.find(t => t.slug === A.slug).id;
  await adm('POST', `/admin/api/tenants/${aid}/plan`, { plan: 'pro' }, { 'x-admin-pin': ADMIN });
  ok((await A.c('POST', `/b/${A.slug}/api/branches`, { name: 'Branch 2' })).status === 200, 'after admin upgrade to pro: 2nd branch allowed');

  console.log(`\n${fail ? '❌ HIERARCHY CHECK FAILED' : '✅ HIERARCHY VERIFIED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });

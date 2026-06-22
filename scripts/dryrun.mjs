// End-to-end SaaS dry run against a LIVE server (boot with SAAS=1 first). Drives the full
// lifecycle over HTTP for TWO brands: signup → login → menu → order → pay → loyalty → report,
// plus admin (suspend/reset) + per-tenant LINE webhook + cross-tenant isolation.
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:4611';
const ADMIN = process.env.SAAS_ADMIN_PIN || 'adminsecret';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const section = (t) => console.log('\n— ' + t + ' —');

// Minimal cookie-jar client (captures Set-Cookie per brand, resends as Cookie).
function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (cookie) h.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}
const raw = async (method, path, bodyStr, headers = {}) => {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: bodyStr });
  return { status: res.status };
};

async function setupBrand(name, pkg, unit, pin) {
  const c = client();
  const su = await c('POST', '/api/signup', { name, package: pkg, unit, pin });
  if (!su.data?.slug) throw new Error('signup failed: ' + JSON.stringify(su.data));
  const slug = su.data.slug;
  await c('POST', `/b/${slug}/api/staff/login`, { pin });            // owner session
  return { c, slug };
}

(async () => {
  console.log('SaaS end-to-end dry run @ ' + BASE);

  // ===== Brand A: POS package =====
  section('Brand A (POS) signup + sell + loyalty');
  const A = await setupBrand('Alpha Cafe', 'pos', 'แก้ว', '1111');
  ok(A.slug === 'alpha-cafe', `A signed up → slug ${A.slug}`);
  const aCfg = (await A.c('GET', `/b/${A.slug}/api/config`)).data;
  ok(aCfg.posOnly === true && aCfg.brand.package === 'pos', 'A config: posOnly=true, package=pos');
  ok(aCfg.selfOrder === false, 'A (POS): customer self-order disabled');
  ok(aCfg.brand.unit === 'แก้ว', 'A brand unit = แก้ว');
  const aZone = (await A.c('GET', `/b/${A.slug}/api/stores`)).data[0];
  const aZoneId = (await A.c('GET', `/b/${A.slug}/api/stores/${aZone.id}/zones`)).data[0].id;
  ok(!!aZoneId, `A has a store "${aZone.name}" + zone ${aZoneId}`);
  await A.c('POST', `/b/${A.slug}/api/menu`, { name: 'Latte', price: 50 });
  const aMenu = (await A.c('GET', `/b/${A.slug}/api/menu`)).data;
  ok(aMenu.length === 1 && aMenu[0].name === 'Latte', 'A added menu "Latte" (only its own)');
  await A.c('POST', `/b/${A.slug}/api/loyalty/settings`, { enabled: true, stampsPerReward: 10, welcomeBonus: 0 });
  // POS self-order endpoint must 404
  const aSelf = await A.c('POST', `/b/${A.slug}/api/zones/${aZoneId}/order`, { items: [{ name: 'x', price: 1 }] });
  ok(aSelf.status === 404, 'A (POS): customer self-order endpoint → 404');
  // create order → attach phone → pay
  const aOrd = await A.c('POST', `/b/${A.slug}/api/zones/${aZoneId}/orders`, { items: [{ name: 'Latte', price: 50, qty: 1 }] });
  ok(aOrd.data?.ticketId > 0, `A cashier order created (ticket ${aOrd.data?.ticketId}, ฿${aOrd.data?.total})`);
  const aAttach = await A.c('POST', `/b/${A.slug}/api/tickets/${aOrd.data.ticketId}/customer`, { phone: '0810000001' });
  ok(aAttach.status === 200, 'A attached customer phone for loyalty');
  const aPay = await A.c('POST', `/b/${A.slug}/api/tickets/${aOrd.data.ticketId}/paid`, { method: 'cash' });
  ok(aPay.status === 200, 'A order paid (cash)');
  const aRep = (await A.c('GET', `/b/${A.slug}/api/report`)).data;
  ok(aRep.revenue === 50, `A daily report revenue = 50 (got ${aRep.revenue})`);
  ok(aRep.pnl?.cups === 1, `A report cups = 1 (got ${aRep.pnl?.cups})`);
  const aLoy = (await A.c('GET', `/b/${A.slug}/api/loyalty/phone/0810000001`)).data;
  ok(aLoy.points >= 1, `A phone loyalty earned (${aLoy.points} pts)`);

  // ===== Brand B: LINE package =====
  section('Brand B (LINE) signup + connect LINE + sell');
  const B = await setupBrand('Bravo Tea', 'line', 'จาน', '2222');
  const bCfg = (await B.c('GET', `/b/${B.slug}/api/config`)).data;
  ok(bCfg.posOnly === false && bCfg.brand.package === 'line', 'B config: posOnly=false, package=line');
  ok(bCfg.saas === true, 'B config: saas=true');
  // connect LINE (owner session)
  await B.c('POST', `/b/${B.slug}/api/admin/line-config`, { token: 'BTOKEN', secret: 'BSECRET', liffId: '999-bravo' });
  const bCfg2 = (await B.c('GET', `/b/${B.slug}/api/config`)).data;
  ok(bCfg2.liffId === '999-bravo' && bCfg2.lineEnabled === true, 'B connected LINE (liffId + lineEnabled)');
  // webhook with B's secret → 200; wrong secret → 401
  const body = JSON.stringify({ events: [] });
  const sigB = createHmac('SHA256', 'BSECRET').update(Buffer.from(body)).digest('base64');
  ok((await raw('POST', `/b/${B.slug}/line/webhook`, body, { 'x-line-signature': sigB })).status === 200, 'B webhook accepts its own secret (200)');
  const sigBad = createHmac('SHA256', 'WRONG').update(Buffer.from(body)).digest('base64');
  ok((await raw('POST', `/b/${B.slug}/line/webhook`, body, { 'x-line-signature': sigBad })).status === 401, 'B webhook rejects a wrong secret (401)');
  // B sells one
  await B.c('POST', `/b/${B.slug}/api/menu`, { name: 'Som Tam', price: 70 });
  const bZone = (await B.c('GET', `/b/${B.slug}/api/stores`)).data[0];
  const bZoneId = (await B.c('GET', `/b/${B.slug}/api/stores/${bZone.id}/zones`)).data[0].id;
  await B.c('POST', `/b/${B.slug}/api/zones/${bZoneId}/orders`, { items: [{ name: 'Som Tam', price: 70, qty: 1 }], pay: 'cash' });
  const bRep = (await B.c('GET', `/b/${B.slug}/api/report`)).data;
  ok(bRep.revenue === 70, `B daily report revenue = 70 (got ${bRep.revenue})`);

  // ===== Isolation =====
  section('Cross-tenant isolation');
  ok(aRep.revenue === 50 && bRep.revenue === 70, 'A=50 / B=70 — reports do not mix');
  const aMenuAfter = (await A.c('GET', `/b/${A.slug}/api/menu`)).data;
  ok(!aMenuAfter.some(m => m.name === 'Som Tam'), 'A menu never shows B\'s "Som Tam"');
  // A's session cookie used on B's URL → not authorized (session bound to A's tenant)
  const crossRep = await A.c('GET', `/b/${B.slug}/api/report`);
  ok(crossRep.status === 403, `A's session cannot read B's report (got ${crossRep.status})`);
  // unknown slug 404
  ok((await A.c('GET', `/b/nope-xyz/api/config`)).status === 404, 'unknown brand slug → 404');

  // ===== Platform admin =====
  section('Platform admin console');
  const adm = client();
  ok((await adm('POST', '/admin/api/login', { adminPin: ADMIN })).data?.ok === true, 'admin login OK');
  ok((await adm('GET', '/admin/api/tenants', null, { 'x-admin-pin': ADMIN })).status === 200, 'admin can list tenants');
  const tenants = (await adm('GET', '/admin/api/tenants', null, { 'x-admin-pin': ADMIN })).data.tenants;
  ok(tenants.some(t => t.slug === 'alpha-cafe') && tenants.some(t => t.slug === 'bravo-tea'), 'admin sees both brands');
  const bId = tenants.find(t => t.slug === 'bravo-tea').id;
  await adm('POST', `/admin/api/tenants/${bId}/suspend`, {}, { 'x-admin-pin': ADMIN });
  ok((await B.c('GET', `/b/${B.slug}/api/config`)).status === 403, 'suspended B → shop returns 403');
  ok((await A.c('GET', `/b/${A.slug}/api/config`)).status === 200, 'A still works while B suspended');
  await adm('POST', `/admin/api/tenants/${bId}/activate`, {}, { 'x-admin-pin': ADMIN });
  ok((await B.c('GET', `/b/${B.slug}/api/config`)).status === 200, 'reactivated B → shop 200');
  const rp = (await adm('POST', `/admin/api/tenants/${bId}/reset-pin`, {}, { 'x-admin-pin': ADMIN })).data;
  const relog = await raw('POST', `/b/${B.slug}/api/staff/login`, JSON.stringify({ pin: rp.pin }));
  ok(rp.pin && relog.status === 200, `admin reset B owner PIN → new PIN ${rp.pin} logs in`);
  ok((await adm('POST', `/admin/api/tenants/1/suspend`, {}, { 'x-admin-pin': ADMIN })).status === 400, 'cannot suspend primary tenant 1');
  ok((await adm('GET', '/admin/api/tenants')).status === 401, 'admin API without PIN → 401');

  // ===== Audit trail =====
  section('Audit trail (sensitive-action forensics)');
  ok((await adm('GET', '/admin/api/audit')).status === 401, 'audit without admin PIN → 401');
  const audit = (await adm('GET', '/admin/api/audit', null, { 'x-admin-pin': ADMIN })).data.events || [];
  const acts = new Set(audit.map(e => e.action));
  ok(acts.has('tenant.suspend') && acts.has('tenant.activate') && acts.has('tenant.reset_pin'), 'admin actions (suspend/activate/reset_pin) recorded');
  ok(audit.some(e => e.action === 'line.config' && e.tenant_id === bId), 'B owner line.config recorded under B');
  const resetEv = audit.find(e => e.action === 'tenant.reset_pin');
  ok(resetEv && !JSON.stringify(resetEv).includes(rp.pin), 'audit never stores the reset PIN');
  ok(audit.every(e => !/[A-Z]TOKEN|[A-Z]SECRET/.test(JSON.stringify(e))), 'audit never stores LINE token/secret values');
  const bOnly = (await adm('GET', `/admin/api/audit?tenantId=${bId}`, null, { 'x-admin-pin': ADMIN })).data.events || [];
  ok(bOnly.length > 0 && bOnly.every(e => e.tenant_id === bId), 'audit ?tenantId scopes to that tenant only');

  console.log(`\n${fail ? '❌ DRY RUN FAILED' : '✅ DRY RUN PASSED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('dry-run crashed:', e); process.exit(2); });

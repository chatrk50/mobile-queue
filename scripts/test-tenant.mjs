import * as DB from '../server/db.js';
import { runWithTenant, currentTenantId, slugify } from '../server/tenant.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

// tenant 1 exists with slug 'main'
const t1 = DB.getTenantBySlug('main');
ok(t1 && t1.id === 1, `tenant 1 has slug 'main' (got ${t1 && t1.slug})`);

// default context = tenant 1
ok(currentTenantId() === 1, 'currentTenantId() defaults to 1 outside a request');

// create two brands
const a = DB.createTenant({ name: 'Bean House Coffee', ownerEmail: 'a@x.com', pkg: 'pos', brandUnit: 'แก้ว' });
const b = DB.createTenant({ name: 'Som Tam Express', ownerEmail: 'b@x.com', pkg: 'line', brandUnit: 'จาน' });
ok(a.id > 1 && b.id > a.id, `createTenant assigns new ids (${a.id}, ${b.id})`);
ok(a.slug === 'bean-house-coffee', `slugify name → slug (got ${a.slug})`);
ok(a.package === 'pos' && b.package === 'line', 'package stored per tenant');

// slug collision → suffixed
const a2 = DB.createTenant({ name: 'Bean House Coffee' });
ok(a2.slug === 'bean-house-coffee-2', `duplicate name → unique slug (got ${a2.slug})`);

// per-tenant settings isolation (tenant 1 bare keys; others namespaced)
runWithTenant(1, () => DB.setSetting('loyalty:enabled', '1'));
runWithTenant(a.id, () => DB.setSetting('loyalty:enabled', '0'));
runWithTenant(b.id, () => DB.setSetting('loyalty:enabled', '1'));
const v1 = runWithTenant(1, () => DB.getSetting('loyalty:enabled'));
const va = runWithTenant(a.id, () => DB.getSetting('loyalty:enabled'));
const vb = runWithTenant(b.id, () => DB.getSetting('loyalty:enabled'));
ok(v1 === '1' && va === '0' && vb === '1', `settings isolated per tenant (1=${v1}, A=${va}, B=${vb})`);

// tenant 1 setting uses a BARE key (no t1: prefix) — backward compatible
const bare = DB.getSetting('loyalty:enabled', null, 1);
ok(bare === '1', 'tenant 1 setting stored under bare key (no migration)');

// a tenant's key does NOT leak into tenant 1
const leak = runWithTenant(1, () => DB.getSetting('loyalty:enabled'));
ok(leak === '1', 'tenant A writing did not overwrite tenant 1');

// brand resolution: tenant uses its own fields; tenant 1 falls back to env defaults
const env = { name: 'YO-DEE Yogurt', short: 'YO-DEE', theme: '#1e3a5f', logo: '/assets/logo.png', unit: 'แก้ว' };
const brA = DB.tenantBrand(a.id, env);
ok(brA.name === 'Bean House Coffee' && brA.unit === 'แก้ว' && brA.package === 'pos', 'tenantBrand returns the tenant brand');
const br1 = DB.tenantBrand(1, env);
ok(br1.name === 'YO-DEE Yogurt' && br1.unit === 'แก้ว', 'tenant 1 brand falls back to env defaults');

console.log(`\n${fail ? '❌' : '✅'} tenant foundation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

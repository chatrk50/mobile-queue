// Backup RESTORE DRILL — a backup you've never restored isn't a backup. Builds real data, dumps it
// with the same dumpSql() the daily backup uses, replays the dump into a FRESH database, and
// verifies every tenant/order/menu came back intact. Run: node --experimental-sqlite scripts/test-restore.mjs
import { DatabaseSync } from 'node:sqlite';
import * as DB from '../server/db.js';
import { db } from '../server/db.js';
import { dumpSql } from '../server/dump.js';
import { runWithTenant } from '../server/tenant.js';
import * as Q from '../server/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

// --- Build representative data across two tenants ---
function build(name) {
  const t = DB.createTenant({ name, pkg: 'pos' });
  runWithTenant(t.id, () => {
    const br = Q.createBranch({ name: name + ' HQ' });
    const zid = db.prepare('SELECT id FROM zones WHERE store_id=? ORDER BY id LIMIT 1').get(br.id).id;
    Q.addMenuItem({ name: name + ' Latte', price: 55 });
    const r = Q.createOrder(zid, [{ name: name + ' Latte', price: 55, qty: 1 }], { source: 'cashier' });
    Q.setOrderPaid(r.ticket.id, { method: 'cash' });
  });
  return t;
}
const a = build('Backup A'), b = build('Backup B');
const before = {
  tenants: db.prepare('SELECT COUNT(*) c FROM tenants').get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  menu: db.prepare('SELECT COUNT(*) c FROM menu_items').get().c,
};

// --- Dump (same code path as the daily backup) ---
const { sql, tables, rows } = dumpSql(db, 'drill');
ok(sql.includes('CREATE TABLE IF NOT EXISTS') && sql.includes('INSERT INTO "tenants"'), `dump has schema + data (${tables} tables, ${rows} rows)`);

// --- Restore into a brand-new database ---
const fresh = new DatabaseSync(':memory:');
fresh.exec(sql);
const after = {
  tenants: fresh.prepare('SELECT COUNT(*) c FROM tenants').get().c,
  orders: fresh.prepare('SELECT COUNT(*) c FROM orders').get().c,
  menu: fresh.prepare('SELECT COUNT(*) c FROM menu_items').get().c,
};
ok(after.tenants === before.tenants && after.tenants >= 3, `tenants restored (${after.tenants}/${before.tenants})`);
ok(after.orders === before.orders && after.orders >= 2, `orders restored (${after.orders}/${before.orders})`);
ok(after.menu === before.menu, `menu items restored (${after.menu}/${before.menu})`);
const ar = fresh.prepare('SELECT name FROM tenants WHERE slug=?').get(a.slug);
ok(ar && ar.name === 'Backup A', 'specific tenant row intact after restore');
const am = fresh.prepare('SELECT COUNT(*) c FROM menu_items WHERE name=?').get('Backup A Latte').c;
ok(am === 1, "tenant A's menu item present in the restored DB");
fresh.close();

console.log(`\n${fail ? '❌' : '✅'} restore drill: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

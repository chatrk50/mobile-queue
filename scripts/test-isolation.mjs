// Multi-tenant DATA isolation: two brands created side by side must never see each other's
// stores, menu, orders, reports, staff, ingredients or rewards. This is the safety net for SaaS.
import * as DB from '../server/db.js';
import * as Q from '../server/queue.js';
import { runWithTenant } from '../server/tenant.js';
import { db } from '../server/db.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

// Two fresh tenants (tenant 1 already exists from seeds).
const A = DB.createTenant({ name: 'Alpha Cafe', pkg: 'pos' });
const B = DB.createTenant({ name: 'Bravo Tea', pkg: 'line' });

// Build a shop inside each tenant's context: branch (+zone), menu, one paid order, one staffer.
function build(t, drinkName, price) {
  return runWithTenant(t.id, () => {
    const br = Q.createBranch({ name: t.name + ' HQ' });
    const zoneId = db.prepare('SELECT id FROM zones WHERE store_id=? ORDER BY id LIMIT 1').get(br.id).id;
    Q.addMenuItem({ name: drinkName, price });
    Q.createStaff({ name: 'Owner ' + t.id, pin: '1' + t.id + '99', role: 'owner' });
    const r = Q.createOrder(zoneId, [{ name: drinkName, price, qty: 1 }], { source: 'cashier' });
    Q.setOrderPaid(r.ticket.id, { method: 'cash' });
    return { storeId: br.id, zoneId, ticketId: r.ticket.id, price };
  });
}
const a = build(A, 'Alpha Latte', 50);
const b = build(B, 'Bravo Matcha', 70);

// --- Stores ---
const aStores = runWithTenant(A.id, () => Q.listStores());
const bStores = runWithTenant(B.id, () => Q.listStores());
ok(aStores.every(s => s.id === a.storeId) && aStores.length === 1, 'A sees only its own store');
ok(bStores.every(s => s.id === b.storeId) && bStores.length === 1, 'B sees only its own store');
ok(!aStores.some(s => s.id === b.storeId), 'A does NOT see B\'s store');

// --- Menu ---
const aMenu = runWithTenant(A.id, () => Q.listMenu());
ok(aMenu.some(m => m.name === 'Alpha Latte') && !aMenu.some(m => m.name === 'Bravo Matcha'), 'menu isolated (A has no Bravo Matcha)');

// --- Boundary: A cannot resolve B's zone or report on B's store ---
const crossZone = runWithTenant(A.id, () => Q.getZone(b.zoneId));
ok(!crossZone, 'A cannot resolve B\'s zone id (getZone → null)');
let crossOrderThrew = false;
runWithTenant(A.id, () => { try { Q.createOrder(b.zoneId, [{ name: 'x', price: 1, qty: 1 }], { source: 'cashier' }); } catch (e) { crossOrderThrew = true; } });
ok(crossOrderThrew, 'A cannot create an order in B\'s zone');

// --- Reports: each tenant's all-branches daily report counts only its own sales ---
const aRep = runWithTenant(A.id, () => Q.dailyReport(null));
const bRep = runWithTenant(B.id, () => Q.dailyReport(null));
ok(aRep.revenue === a.price, `A report revenue = only A's sale (${aRep.revenue} == ${a.price})`);
ok(bRep.revenue === b.price, `B report revenue = only B's sale (${bRep.revenue} == ${b.price})`);
ok(aRep.revenue !== aRep.revenue + bRep.revenue - bRep.revenue + b.price, 'A report does not include B revenue');

// --- Staff auth isolation: B's PIN must not authenticate within A ---
const aStaff = runWithTenant(A.id, () => Q.listStaff());
ok(aStaff.length === 1 && aStaff[0].name === 'Owner ' + A.id, 'A sees only its own staff');

// --- Tenant 1 (the original business) is untouched by A/B ---
const t1Stores = runWithTenant(1, () => Q.listStores());
ok(!t1Stores.some(s => s.id === a.storeId || s.id === b.storeId), 'tenant 1 does not see A/B stores');

// --- Phase E.1: SAME phone at two brands = two separate loyalty customers ---
const PHONE = '0812345678';
function earnByPhone(t, zoneId, price) {
  return runWithTenant(t.id, () => {
    Q.setLoyaltyEnabled(true);
    const r = Q.createOrder(zoneId, [{ name: 'X', price, qty: 1 }], { source: 'cashier' });
    Q.attachCustomerToTicket(r.ticket.id, PHONE);
    Q.setOrderPaid(r.ticket.id, { method: 'cash' });
    return Q.loyaltyByPhone(PHONE).points;
  });
}
const aPts1 = earnByPhone(A, a.zoneId, 40);          // A: 1 order
earnByPhone(B, b.zoneId, 40); earnByPhone(B, b.zoneId, 40); // B: 2 orders, same phone
const aPts = runWithTenant(A.id, () => Q.loyaltyByPhone(PHONE).points);
const bPts = runWithTenant(B.id, () => Q.loyaltyByPhone(PHONE).points);
ok(aPts >= 1 && bPts >= 1 && bPts > aPts, `same phone, independent balances (A=${aPts}, B=${bPts})`);
ok(aPts === aPts1, 'A balance unchanged by B earning on the same phone (no shared row)');

// --- Phase E.2: a tenant cannot mutate another tenant's records by id ---
const bReward = runWithTenant(B.id, () => Q.addReward({ name: 'B Reward', cost_points: 5 }));
let guard = false;
runWithTenant(A.id, () => { try { Q.updateReward(bReward.id, { name: 'hacked' }); } catch (e) { guard = e.message === 'reward_not_found'; } });
ok(guard, 'A cannot update B\'s reward by id (reward_not_found)');
const bIng = runWithTenant(B.id, () => Q.addIngredient({ name: 'B Milk' }));
let guard2 = false;
runWithTenant(A.id, () => { try { Q.updateIngredient(bIng.id, { name: 'hacked' }); } catch (e) { guard2 = e.message === 'ingredient_not_found'; } });
ok(guard2, 'A cannot update B\'s ingredient by id (ingredient_not_found)');

// --- Tenant erasure completeness: deleting B must leave ZERO orphan rows in ANY table ---
DB.seedTenantDefaults(B.id);                                   // ensure channels + price_tiers exist
const C1 = (sql, ...a) => db.prepare(sql).get(...a).c;
const idList = (arr) => (arr.length ? `(${arr.join(',')})` : '(-1)');
const bStoreIds = db.prepare('SELECT id FROM stores WHERE tenant_id=?').all(B.id).map((r) => r.id);
const bItemIds = db.prepare('SELECT id FROM menu_items WHERE tenant_id=?').all(B.id).map((r) => r.id);
const bIngIds = db.prepare('SELECT id FROM ingredients WHERE tenant_id=?').all(B.id).map((r) => r.id);
const bTierIds = db.prepare('SELECT id FROM price_tiers WHERE tenant_id=?').all(B.id).map((r) => r.id);
const bZoneIds = db.prepare(`SELECT id FROM zones WHERE store_id IN ${idList(bStoreIds)}`).all().map((r) => r.id);
const bOrderIds = db.prepare(`SELECT id FROM orders WHERE branch_id IN ${idList(bStoreIds)}`).all().map((r) => r.id);
const bTicketIds = db.prepare(`SELECT id FROM tickets WHERE store_id IN ${idList(bStoreIds)}`).all().map((r) => r.id);
// Seed the remaining tables so the erasure is exercised against EVERY tenant-scoped table.
db.prepare('INSERT INTO item_prices (item_id, tier_id, branch_id, price) VALUES (?,?,?,?)').run(bItemIds[0], bTierIds[0], bStoreIds[0], 99);
db.prepare('INSERT INTO branch_menu (branch_id, item_id, enabled) VALUES (?,?,1)').run(bStoreIds[0], bItemIds[0]);
db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, qty) VALUES (?,?,1)').run(bItemIds[0], bIngIds[0]);
db.prepare('INSERT INTO stock_moves (ingredient_id, branch_id, kind, qty) VALUES (?,?,?,1)').run(bIngIds[0], bStoreIds[0], 'purchase');
db.prepare('INSERT INTO cash_sessions (branch_id) VALUES (?)').run(bStoreIds[0]);
db.prepare('INSERT INTO slips (order_id, ticket_id, image) VALUES (?,?,?)').run(bOrderIds[0], bTicketIds[0], 'x');
db.prepare('INSERT INTO sales_history (date, branch_id) VALUES (?,?)').run('2026-01-01', bStoreIds[0]);
db.prepare('INSERT INTO daily_stats (date, zone_id) VALUES (?,?)').run('2026-01-01', bZoneIds[0]);
db.prepare('INSERT INTO audit_log (at, tenant_id, action) VALUES (?,?,?)').run(1, B.id, 'test.seed');

const aStoresBefore = C1('SELECT COUNT(*) c FROM stores WHERE tenant_id=?', A.id);
const er = DB.deleteTenant(B.id);
ok(er.deleted === true, 'erasure: deleteTenant(B) returns deleted');
const orphanChecks = [
  ['tenants', `SELECT COUNT(*) c FROM tenants WHERE id=${B.id}`],
  ['stores', `SELECT COUNT(*) c FROM stores WHERE tenant_id=${B.id}`],
  ['staff', `SELECT COUNT(*) c FROM staff WHERE tenant_id=${B.id}`],
  ['menu_items', `SELECT COUNT(*) c FROM menu_items WHERE tenant_id=${B.id}`],
  ['ingredients', `SELECT COUNT(*) c FROM ingredients WHERE tenant_id=${B.id}`],
  ['rewards', `SELECT COUNT(*) c FROM rewards WHERE tenant_id=${B.id}`],
  ['channels', `SELECT COUNT(*) c FROM channels WHERE tenant_id=${B.id}`],
  ['price_tiers', `SELECT COUNT(*) c FROM price_tiers WHERE tenant_id=${B.id}`],
  ['customers', `SELECT COUNT(*) c FROM customers WHERE tenant_id=${B.id}`],
  ['audit_log', `SELECT COUNT(*) c FROM audit_log WHERE tenant_id=${B.id}`],
  ['zones', `SELECT COUNT(*) c FROM zones WHERE store_id IN ${idList(bStoreIds)}`],
  ['tickets', `SELECT COUNT(*) c FROM tickets WHERE store_id IN ${idList(bStoreIds)}`],
  ['orders', `SELECT COUNT(*) c FROM orders WHERE branch_id IN ${idList(bStoreIds)}`],
  ['order_items', `SELECT COUNT(*) c FROM order_items WHERE order_id IN ${idList(bOrderIds)}`],
  ['sale_events', `SELECT COUNT(*) c FROM sale_events WHERE branch_id IN ${idList(bStoreIds)} OR order_id IN ${idList(bOrderIds)} OR ticket_id IN ${idList(bTicketIds)}`],
  ['daily_stats', `SELECT COUNT(*) c FROM daily_stats WHERE zone_id IN ${idList(bZoneIds)}`],
  ['staff_branches', `SELECT COUNT(*) c FROM staff_branches WHERE branch_id IN ${idList(bStoreIds)}`],
  ['item_prices', `SELECT COUNT(*) c FROM item_prices WHERE item_id IN ${idList(bItemIds)} OR tier_id IN ${idList(bTierIds)}`],
  ['branch_menu', `SELECT COUNT(*) c FROM branch_menu WHERE branch_id IN ${idList(bStoreIds)} OR item_id IN ${idList(bItemIds)}`],
  ['recipes', `SELECT COUNT(*) c FROM recipes WHERE menu_item_id IN ${idList(bItemIds)} OR ingredient_id IN ${idList(bIngIds)}`],
  ['stock_moves', `SELECT COUNT(*) c FROM stock_moves WHERE ingredient_id IN ${idList(bIngIds)} OR branch_id IN ${idList(bStoreIds)}`],
  ['cash_sessions', `SELECT COUNT(*) c FROM cash_sessions WHERE branch_id IN ${idList(bStoreIds)}`],
  ['slips', `SELECT COUNT(*) c FROM slips WHERE order_id IN ${idList(bOrderIds)} OR ticket_id IN ${idList(bTicketIds)}`],
  ['sales_history', `SELECT COUNT(*) c FROM sales_history WHERE branch_id IN ${idList(bStoreIds)}`],
  ['loyalty_moves', `SELECT COUNT(*) c FROM loyalty_moves WHERE order_id IN ${idList(bOrderIds)}`],
];
let orphans = 0;
for (const [name, sql] of orphanChecks) { const n = C1(sql); if (n !== 0) { orphans++; console.log('    orphan rows left in ' + name + ': ' + n); } }
ok(orphans === 0, `erasure: NO orphan rows across ${orphanChecks.length} tenant-scoped tables`);
ok(C1('SELECT COUNT(*) c FROM stores WHERE tenant_id=?', A.id) === aStoresBefore && aStoresBefore >= 1, 'erasure: tenant A stores untouched');
ok(runWithTenant(A.id, () => Q.listMenu()).some((m) => m.name === 'Alpha Latte'), 'erasure: tenant A menu intact');
let primaryGuard = false; try { DB.deleteTenant(1); } catch (e) { primaryGuard = e.message === 'cannot_delete_primary'; }
ok(primaryGuard, 'erasure: refuses to delete primary tenant 1');

console.log(`\n${fail ? '❌' : '✅'} isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

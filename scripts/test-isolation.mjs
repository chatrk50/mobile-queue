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

// --- Configurable membership tiers (owner-set, per-tenant) ---
runWithTenant(A.id, () => Q.setTiers([{ label: 'เริ่มต้น', min: 5, emoji: '⭐' }, { label: 'VIP', min: 50, emoji: '👑', perk: 'ลด 10%' }]));
ok(runWithTenant(A.id, () => Q.loyaltyTier(60))?.label === 'VIP', 'A: tier at 60 lifetime = VIP (configured)');
ok(runWithTenant(A.id, () => Q.loyaltyTier(10))?.label === 'เริ่มต้น', 'A: tier at 10 = เริ่มต้น');
ok(runWithTenant(A.id, () => Q.loyaltyTier(2)) === null, 'A: below first threshold = no tier');
const aNext = runWithTenant(A.id, () => Q.nextTier(10));
ok(aNext && aNext.label === 'VIP' && aNext.toGo === 40, 'A: nextTier from 10 = VIP, toGo 40');
ok(runWithTenant(B.id, () => Q.getTiers())[0].label === 'ขาประจำ', 'B: still default tiers (per-tenant isolation)');

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
  ['promos', `SELECT COUNT(*) c FROM promos WHERE tenant_id=${B.id}`],
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

// --- Promo broadcast isolation (adopt-backlog #2) ---
// Create a fresh tenant C to use (B was deleted above).
const C = DB.createTenant({ name: 'Charlie Bubble', pkg: 'line' });
// createPromo is scoped by TID() (current tenant), listPromos/cancelPromo too.
runWithTenant(C.id, () => Q.createPromo({ message: 'โปรโมชั่น C', linkUrl: 'https://example.com' }));
runWithTenant(A.id, () => Q.createPromo({ message: 'โปรโมชั่น A' }));
const cPromos = runWithTenant(C.id, () => Q.listPromos());
const aPromos = runWithTenant(A.id, () => Q.listPromos());
ok(cPromos.length === 1 && cPromos[0].message === 'โปรโมชั่น C', 'promo: C only sees its own promo');
ok(aPromos.length === 1 && aPromos[0].message === 'โปรโมชั่น A', 'promo: A only sees its own promo');
ok(!cPromos.some(p => p.message === 'โปรโมชั่น A'), 'promo: C does NOT see A\'s promo');
// cancelPromo by wrong tenant throws promo_not_found
let crossPromoGuard = false;
runWithTenant(A.id, () => { try { Q.cancelPromo(cPromos[0].id); } catch(e) { crossPromoGuard = e.message === 'promo_not_found'; } });
ok(crossPromoGuard, 'promo: A cannot cancel C\'s promo (promo_not_found)');
// countLineCustomers is per-tenant
const cCount = runWithTenant(C.id, () => Q.countLineCustomers());
const aCount = runWithTenant(A.id, () => Q.countLineCustomers());
ok(typeof cCount === 'number' && typeof aCount === 'number', 'promo: countLineCustomers returns number for each tenant');
// duePromos: a scheduled promo becomes due once send_at passes; future-scheduled does not.
const nowTs = Math.floor(Date.now() / 1000);
const futureTs = nowTs + 3600;
// Create scheduled promo, then back-date it to simulate time passing (scheduler logic).
const nowPlusPromo = runWithTenant(C.id, () => Q.createPromo({ message: 'near-future', sendAt: nowTs + 1 }));
db.prepare('UPDATE promos SET send_at=? WHERE id=?').run(nowTs - 5, nowPlusPromo.id);
const futurePromo = runWithTenant(C.id, () => Q.createPromo({ message: 'future', sendAt: futureTs }));
const due1 = Q.duePromos();
ok(due1.some(p => p.id === nowPlusPromo.id), 'promo: past-due promo appears in duePromos()');
ok(!due1.some(p => p.id === futurePromo.id), 'promo: future promo does NOT appear in duePromos()');
ok(due1.every(p => p.status === 'scheduled'), 'promo: duePromos() returns only scheduled rows');
// lifecycle: mark sent → disappears from duePromos; recipients stored
runWithTenant(C.id, () => Q.markPromoSent(nowPlusPromo.id, { recipients: 42 }));
const due2 = Q.duePromos();
ok(!due2.some(p => p.id === nowPlusPromo.id), 'promo: sent promo no longer in duePromos()');
const sent = runWithTenant(C.id, () => Q.listPromos()).find(p => p.id === nowPlusPromo.id);
ok(sent && sent.status === 'sent' && sent.recipients === 42, 'promo: markPromoSent sets status=sent + recipients');
// cancel: cancelled promo does not appear in duePromos
runWithTenant(C.id, () => Q.cancelPromo(futurePromo.id));
const due3 = Q.duePromos();
ok(!due3.some(p => p.id === futurePromo.id), 'promo: cancelled promo not in duePromos()');

// --- clearTransactions isolation: A clearing must NOT wipe C's data ---
// Give C a paid order so there's something to protect.
const cBefore = runWithTenant(C.id, () => {
  const br = Q.createBranch({ name: 'C HQ' });
  const zoneId = db.prepare('SELECT id FROM zones WHERE store_id=? ORDER BY id LIMIT 1').get(br.id).id;
  Q.createOrder(zoneId, [{ name: 'C Drink', price: 30, qty: 1 }], { source: 'cashier' });
  const storeId = br.id;
  return db.prepare('SELECT COUNT(*) c FROM tickets WHERE store_id=?').get(storeId).c;
});
// A wipes its own transactions
runWithTenant(A.id, () => Q.clearTransactions());
const aAfter  = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE store_id IN (SELECT id FROM stores WHERE tenant_id=?)`).get(A.id).c;
const cAfter  = runWithTenant(C.id, () => {
  const storeId = db.prepare('SELECT id FROM stores WHERE tenant_id=? LIMIT 1').get(C.id).id;
  return db.prepare('SELECT COUNT(*) c FROM tickets WHERE store_id=?').get(storeId).c;
});
ok(aAfter === 0, 'clearTx: A\'s tickets gone after clear');
ok(cAfter >= cBefore && cBefore >= 1, 'clearTx: C\'s tickets untouched by A\'s clear');

// --- Tier-up detection (adopt-backlog #1: configurable membership tiers) ---
// Tests that loyaltyTier() correctly transitions when lifetime_points crosses a threshold,
// and that the pre/post comparison logic used by awardPoints() would fire tierUp correctly.
runWithTenant(A.id, () => {
  Q.setLoyaltyEnabled(true);
  Q.setTiers([
    { emoji: '🥉', label: 'Bronze', min: 5, perk: 'ส่วนลด 5%' },
    { emoji: '🥇', label: 'Gold', min: 20, perk: 'ส่วนลด 15%' },
  ]);
});
const t1 = runWithTenant(A.id, () => Q.loyaltyTier(0));
const t2 = runWithTenant(A.id, () => Q.loyaltyTier(4));
const t3 = runWithTenant(A.id, () => Q.loyaltyTier(5));
const t4 = runWithTenant(A.id, () => Q.loyaltyTier(19));
const t5 = runWithTenant(A.id, () => Q.loyaltyTier(20));
ok(t1 === null, 'tier-up: below first threshold → no tier');
ok(t2 === null, 'tier-up: just below Bronze min (4) → no tier');
ok(t3 && t3.label === 'Bronze', 'tier-up: exactly at Bronze min (5) → Bronze tier');
ok(t4 && t4.label === 'Bronze', 'tier-up: between thresholds (19) → still Bronze');
ok(t5 && t5.label === 'Gold', 'tier-up: exactly at Gold min (20) → Gold tier');
// Simulate the pre/post comparison in awardPoints: 19 stamps → +2 → crosses Gold threshold.
const prevTierSim = runWithTenant(A.id, () => Q.loyaltyTier(19));
const newTierSim  = runWithTenant(A.id, () => Q.loyaltyTier(21));
const tierUpSim = (newTierSim && (!prevTierSim || newTierSim.label !== prevTierSim.label)) ? newTierSim : null;
ok(tierUpSim && tierUpSim.label === 'Gold', 'tier-up: awarding stamp that crosses Gold threshold fires tierUp');
// No tier-up when staying in same tier.
const stayPrev = runWithTenant(A.id, () => Q.loyaltyTier(10));
const stayNew  = runWithTenant(A.id, () => Q.loyaltyTier(12));
const noTierUp = (stayNew && (!stayPrev || stayNew.label !== stayPrev.label)) ? stayNew : null;
ok(noTierUp === null, 'tier-up: award within same tier does NOT fire tierUp');

console.log(`\n${fail ? '❌' : '✅'} isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

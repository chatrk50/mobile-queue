// Regression suite for the money/reconciliation invariants. Exercises the queue
// functions directly against a throwaway local DB (no server, no network).
//   Run:  npm run test:e2e   (exits non-zero on any failure)
import { rmSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', '.e2e-test');
process.env.QUEUE_DATA_DIR = dir;
delete process.env.TURSO_DATABASE_URL;   // always test on local node:sqlite
delete process.env.TURSO_AUTH_TOKEN;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

const { db } = await import('../server/db.js');     // seeds tenant/owner/tiers/channels
const Q = await import('../server/queue.js');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS' : '  FAIL') + ': ' + m); if (!c) fail++; };
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.001;

// ---- minimal seed (db.js doesn't create a store; seed.js normally does) ----
db.prepare("INSERT INTO stores (id, name) VALUES (1, 'Test Shop')").run();
db.prepare("INSERT INTO zones (id, store_id, name, prefix) VALUES (1, 1, 'A', 'A')").run();
db.prepare("INSERT INTO menu_items (name, price, category) VALUES ('Drink', 100, 'drink')").run();
db.prepare("INSERT INTO menu_items (name, price, category) VALUES ('Topping', 10, 'topping')").run();
const grab = db.prepare("SELECT id FROM channels WHERE name='Grab'").get().id;

function sale({ items, method = 'cash', discount = 0, channelId = null }) {
  const r = Q.createOrder(1, items, { channelId });
  if (discount) Q.setOrderDiscount(r.ticket.id, { amount: discount });
  Q.setOrderPaid(r.ticket.id, { method });
  return r.ticket.id;
}

console.log('\n== Cash-up + sales reconciliation ==');
Q.openCashSession(1, { openFloat: 500 });
sale({ items: [{ name: 'Drink', price: 100, qty: 1 }], method: 'cash' });                       // S1 cash 100
sale({ items: [{ name: 'Drink', price: 100, qty: 1 }], method: 'cash', discount: 20 });          // S2 cash net 80
sale({ items: [{ name: 'Drink', price: 100, qty: 1 }], method: 'promptpay', channelId: grab });  // S3 grab pp 100
const s4 = sale({ items: [{ name: 'Drink', price: 50, qty: 1 }], method: 'cash' });              // S4 cash 50 ...
Q.cancelOrderTicket(s4, null, { reason: 'test refund' });                                        // ... refunded

const rep = Q.dailyReport();
const det = Q.detailedReports({});

ok(near(rep.grossSales, 300), `gross sales 300 (S1+S2+S3, S4 voided) — got ${rep.grossSales}`);
ok(near(rep.discounts, 20), `discounts 20 — got ${rep.discounts}`);
ok(near(rep.revenue, 280), `INVARIANT gross−discount==net: 300−20==${rep.revenue}`);

const paySum = det.payments.reduce((s, p) => s + p.amount, 0);
ok(near(paySum, 280) && near(det.paidTotal, 280), `INVARIANT Σpayments==net revenue: ${paySum}/${det.paidTotal}==280`);
ok(near(rep.revenue, det.paidTotal), `INVARIANT dailyReport.revenue==detailed.paidTotal (${rep.revenue})`);

const gr = det.channels.find((c) => c.channel === 'Grab');
ok(gr && near(gr.gross, 100) && near(gr.commission, 30) && near(gr.net, 70),
  `INVARIANT channel net-after-commission: Grab 100→70 — got ${JSON.stringify(gr)}`);
ok(near(det.channelTotals.gross, det.paidTotal), `INVARIANT Σchannel gross==paidTotal (${det.channelTotals.gross})`);

// ---- Order-source mix (how orders came in: walk-in vs LINE vs delivery), share of the day ----
ok(det.sourceTotalOrders === 3, `INVARIANT source mix counts non-void orders (3) — got ${det.sourceTotalOrders}`);
const counterSrc = det.sources.find((s) => s.key === 'counter');
ok(counterSrc && counterSrc.orders === 2, `walk-in counter = 2 orders (S1,S2) — got ${JSON.stringify(counterSrc)}`);
ok(near(det.sources.reduce((s, x) => s + x.pct, 0), 100), `INVARIANT source % sum to ~100 — got ${det.sources.reduce((s, x) => s + x.pct, 0)}`);

const refund = det.voidTotals.refund;
ok(refund && refund.count === 1 && near(refund.amount, 50), 'S4 recorded as a refund (1 × 50)');

// ---- P&L: every line of the profit chain must follow from the settings + sales ----
console.log('\n== P&L formulas ==');
const p = rep.pnl, f = rep.settings;
ok(near(p.cups, 3), `P&L cups == 3 paid drinks (S4 voided, excluded) — got ${p.cups}`);
ok(near(det.cups, p.cups), `INVARIANT detailedReports.cups == P&L cups (header summary) — got ${det.cups}`);
ok(near(p.ingredient, f.ingredientPct * rep.revenue), `INVARIANT P&L ingredient == pct×revenue (${f.ingredientPct}×${rep.revenue}=${p.ingredient})`);
ok(near(p.packaging, f.packagingPerCup * p.cups), `INVARIANT P&L packaging == perCup×cups (${f.packagingPerCup}×${p.cups}=${p.packaging})`);
ok(near(p.cogs, p.ingredient + p.packaging), `INVARIANT P&L COGS == ingredient+packaging (${p.cogs})`);
ok(near(p.grossProfit, rep.revenue - p.cogs), `INVARIANT P&L grossProfit == revenue−COGS (${p.grossProfit})`);
const dailyOpex = (f.rent + f.wages + f.utilities + f.supplies + f.marketing) / f.daysPerMonth;
ok(near(p.opexDaily, dailyOpex), `INVARIANT P&L opexDaily == Σopex/days (${p.opexDaily})`);
ok(near(p.netProfit, p.grossProfit - p.opexDaily - p.wasteCost), `INVARIANT P&L netProfit == grossProfit−opexDaily−waste (${p.netProfit})`);
ok(near(p.grossMargin, rep.revenue ? p.grossProfit / rep.revenue : 0), `INVARIANT P&L grossMargin == grossProfit/revenue (${p.grossMargin})`);

console.log('\n== Cash drawer ==');
const cs = Q.currentCashSession(1);
ok(near(cs.cashIn, 230), `cashIn 230 (S1 100 + S2 80 + S4 50, incl. refunded) — got ${cs.cashIn}`);
ok(near(cs.cashRefund, 50), `cashRefund 50 — got ${cs.cashRefund}`);
ok(near(cs.expectedCash, 680), `INVARIANT expected==float+cashIn−refund: 500+230−50==${cs.expectedCash}`);
const close = Q.closeCashSession(1, { countedCash: 680 });
ok(near(close.overShort, 0), `counted 680 == expected → over/short 0 (got ${close.overShort})`);

console.log('\n== Per-branch scoping ==');
ok(near(Q.dailyReport(1).revenue, rep.revenue), `INVARIANT dailyReport(1)==dailyReport(null) (${rep.revenue})`);
ok(near(Q.dailyReport(999).revenue, 0), 'dailyReport(non-existent branch) revenue 0');

console.log('\n== Branch + per-branch finance ==');
const nb = Q.createBranch({ name: 'Branch 2' });
ok(nb.id === 2 && nb.zones === 1, 'createBranch → id 2 with a default zone');
Q.setFinanceSettings({ rent: 9999 }, 2);
ok(Q.getFinanceSettings(2).rent === 9999 && Q.getFinanceSettings(1).rent !== 9999, 'per-branch finance isolated from global');

// ---- Idempotency: a retried create (+pay) with the same token must NOT duplicate the order ----
console.log('\n== Idempotency (client_token) ==');
const tok = 'tok-idem-001';
const i1 = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], { clientToken: tok });
const i2 = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], { clientToken: tok });
ok(i1.ticket.id === i2.ticket.id && i2.idempotent === true, `INVARIANT same token → same order, no dup (${i1.ticket.id}==${i2.ticket.id}, idempotent=${i2.idempotent})`);
ok(db.prepare('SELECT COUNT(*) n FROM tickets WHERE client_token=?').get(tok).n === 1, 'INVARIANT exactly 1 ticket exists for the token');
const i3 = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], { clientToken: 'tok-idem-002' });
ok(i3.ticket.id !== i1.ticket.id && !i3.idempotent, 'a different token → a new order');
const pay1 = Q.setOrderPaid(i1.ticket.id, { method: 'cash' });
const pay2 = Q.setOrderPaid(i1.ticket.id, { method: 'cash' });
ok(pay1.code === pay2.code && pay2.alreadyPaid === true, `INVARIANT setOrderPaid idempotent — pay twice, one charge (code ${pay1.code}, alreadyPaid=${pay2.alreadyPaid})`);

// ---- รวมบิล (merge pay): settle several pending bills in one tender; each keeps its queue number ----
console.log('\n== Merge pay (รวมบิล) ==');
const m1 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 1 }], {});
const m2 = Q.createOrder(1, [{ name: 'Drink', price: 60, qty: 1 }], {});
const mres = Q.payMulti([m1.ticket.id, m2.ticket.id], { method: 'cash' });
ok(mres.count === 2 && near(mres.total, 100), `INVARIANT payMulti settles all selected bills (count ${mres.count}, total ${mres.total})`);
ok(mres.codes.length === 2 && mres.codes[0] !== mres.codes[1], `each merged bill keeps its OWN queue number (${mres.codes.join(',')})`);
ok(db.prepare('SELECT COUNT(*) n FROM orders WHERE ticket_id IN (?,?) AND payment_status=?').get(m1.ticket.id, m2.ticket.id, 'paid').n === 2, 'both merged orders are now paid');
const mre = Q.payMulti([m1.ticket.id, m2.ticket.id], { method: 'cash' }); // idempotent re-run
ok(mre.results.every((r) => r.alreadyPaid), 'INVARIANT re-running payMulti is a no-op (idempotent)');

// ---- แยกจ่ายตามเงิน (partial pay): accumulate payments until the bill is covered, THEN issue queue# ----
console.log('\n== Partial pay (แยกตามเงิน) ==');
const sp = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});
const p1r = Q.payPartial(sp.ticket.id, 40, { method: 'cash' });
ok(p1r.settled === false && near(p1r.remaining, 60), `INVARIANT partial pay leaves a balance, no settle (paid ${p1r.paid}, remaining ${p1r.remaining})`);
ok(db.prepare('SELECT payment_status FROM orders WHERE ticket_id=?').get(sp.ticket.id).payment_status === 'unpaid', 'INVARIANT order stays UNPAID (no queue number) until fully covered');
// The cashier board reads paid-so-far via orderForTicket → must expose paid_amount so the "จ่ายแล้ว/เหลือ"
// pill shows and the next partial dialog defaults to the REMAINING balance (not the full total).
ok(near(Q.orderForTicket(sp.ticket.id).paid_amount, 40), `INVARIANT orderForTicket exposes paid_amount after a partial (${Q.orderForTicket(sp.ticket.id).paid_amount})`);
const p2r = Q.payPartial(sp.ticket.id, 60, { method: 'cash' });
ok(p2r.settled === true && p2r.code, `INVARIANT covering the balance settles + issues a queue number (${p2r.code})`);
ok(db.prepare('SELECT payment_status FROM orders WHERE ticket_id=?').get(sp.ticket.id).payment_status === 'paid', 'order is now paid');
const op = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
const opr = Q.payPartial(op.ticket.id, 100, { method: 'cash' });
ok(opr.settled === true && near(opr.change, 50), `INVARIANT overpay on a partial settles + returns change (change ${opr.change})`);

// ---- แยกจ่ายตามรายการ (pay by item): paid lines are TRACKED (paid_lines) so paid items show "ชำระแล้ว"
// and can't be collected twice; the server computes the line subtotal authoritatively. ----
console.log('\n== Split by item (แยกตามรายการ) ==');
const si = Q.createOrder(1, [{ name: 'A', price: 40, qty: 1 }, { name: 'B', price: 30, qty: 1 }, { name: 'C', price: 50, qty: 1 }], {});
const it1 = Q.payItems(si.ticket.id, [0, 1], { method: 'cash' });
ok(it1.settled === false && near(it1.paidNow, 70) && near(it1.remaining, 50), `INVARIANT pay-items charges the lines' server subtotal (paidNow ${it1.paidNow}, remaining ${it1.remaining})`);
const linesAfter = Q.orderForTicket(si.ticket.id).lines;
ok(linesAfter[0].paid && linesAfter[1].paid && !linesAfter[2].paid, `INVARIANT only the paid lines are flagged paid (${linesAfter.map((l) => +l.paid).join(',')})`);
let dupBlocked = false; try { Q.payItems(si.ticket.id, [0], { method: 'cash' }); } catch (e) { dupBlocked = e.message === 'no_items'; }
ok(dupBlocked, 'INVARIANT an already-paid line cannot be collected again (no_items)');
const it2 = Q.payItems(si.ticket.id, [2], { method: 'cash' });
ok(it2.settled === true && it2.code, `INVARIANT paying the last line settles + issues the queue number (${it2.code})`);

// ---- แก้ไขออเดอร์ (edit unpaid order in place): change items + total, guarded once money is involved ----
console.log('\n== Edit order (แก้ไขออเดอร์) ==');
const eo = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});
const er = Q.editOrderItems(eo.ticket.id, [{ name: 'Drink', price: 100, qty: 2 }, { name: 'Topping', price: 10, qty: 1 }]);
ok(near(er.total, 210), `editOrderItems replaces items + recomputes total (210) — got ${er.total}`);
const eitems = db.prepare('SELECT name, qty, kind FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.ticket_id=? ORDER BY oi.id').all(eo.ticket.id);
ok(eitems.length === 2 && eitems.some((i) => i.name === 'Topping' && i.kind === 'addon'), 'edited items persisted with correct kind (Topping=addon)');
ok(near(db.prepare('SELECT total FROM orders WHERE ticket_id=?').get(eo.ticket.id).total, 210), 'order total updated to 210');
Q.setOrderPaid(eo.ticket.id, { method: 'cash' });
let editPaidErr = null; try { Q.editOrderItems(eo.ticket.id, [{ name: 'Drink', price: 1, qty: 1 }]); } catch (e) { editPaidErr = e.message; }
ok(editPaidErr === 'already_paid', `INVARIANT cannot edit a PAID order (got ${editPaidErr})`);

// ---- "Today" is date-scoped: an order from another day must NOT count in today's revenue ----
console.log('\n== Daily report is date-scoped (today only) ==');
const todayRev = Q.dailyReport().revenue;
const yo = Q.createOrder(1, [{ name: 'Drink', price: 70, qty: 1 }], {});
Q.setOrderPaid(yo.ticket.id, { method: 'cash' });
const yoOid = db.prepare('SELECT id FROM orders WHERE ticket_id=?').get(yo.ticket.id).id;
ok(Q.dailyReport().revenue === todayRev + 70, `a fresh paid order counts today (+70 → ${Q.dailyReport().revenue})`);
db.prepare("UPDATE orders SET paid_at = datetime('now','-2 days') WHERE id=?").run(yoOid);
ok(Q.dailyReport().revenue === todayRev, `INVARIANT an older-day order is EXCLUDED from today's revenue (back to ${todayRev})`);

// ---- Midnight reset must be safe (used to throw a FK error) and restart the queue counters ----
console.log('\n== Midnight reset is safe + restarts queue numbers ==');
const ordersBefore = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
let resetErr = null; try { Q.resetAllZones(); } catch (e) { resetErr = e.message; }
ok(resetErr === null, `INVARIANT resetAllZones does NOT throw (was FK-failing) — got ${resetErr}`);
ok(db.prepare('SELECT last_number FROM zones WHERE id=1').get().last_number === 0, 'INVARIANT queue counter restarts at 0 after reset');
ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n === ordersBefore, `orders persist across the reset (history kept — ${ordersBefore})`);

// ---- "cups" means drink UNITS sold (sum qty), never order/ticket count ----
console.log('\n== Cups = drink units, not orders ==');
const cupsBefore = Q.dailyReport().pnl.cups;
const mc = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 2 }], {});
Q.setOrderPaid(mc.ticket.id, { method: 'cash' });
ok(Q.dailyReport().pnl.cups === cupsBefore + 2, `INVARIANT a 2-drink order adds 2 cups to P&L, not 1 (${cupsBefore} -> ${Q.dailyReport().pnl.cups})`);

// ---- "issued" = queue numbers actually issued (paid), not just tickets created ----
console.log('\n== issued counts paid queue numbers, not pending/cancelled ==');
const issuedBefore = Q.dailyReport().issued;
const pend = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});   // created, unpaid → no queue number yet
ok(Q.dailyReport().issued === issuedBefore, `INVARIANT a pending (unpaid) order does NOT count as issued (${issuedBefore})`);
Q.setOrderPaid(pend.ticket.id, { method: 'cash' });
ok(Q.dailyReport().issued === issuedBefore + 1, `INVARIANT paying issues a queue number → issued +1 (${Q.dailyReport().issued})`);

// ---- Queue-first: a number is issued at order creation; pay is still required before serving ----
console.log('\n== Queue-first model ==');
Q.setQueueFirst(true);
const qf = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});
ok(qf.ticket.number > 0 && qf.ticket.status === 'waiting', `INVARIANT queue number issued at creation (number ${qf.ticket.number}, status ${qf.ticket.status})`);
// The เข้าคิวทันที (queue-first) toggle is the single source of truth: with it ON, EVERY new order —
// including a held/unpaid "พักบิล" — gets a queue number immediately (it waits in the queue, unpaid).
const held = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
ok(held.ticket.number > 0 && held.ticket.status === 'waiting', `INVARIANT held bill is numbered under queue-first (number ${held.ticket.number}, status ${held.ticket.status})`);
let qfServed = false; try { Q.setStatus(qf.ticket.id, 'served'); qfServed = true; } catch (e) { /* order_unpaid */ }
ok(!qfServed, 'INVARIANT an unpaid queued order canNOT be served (pay-before-serve preserved)');
Q.setOrderPaid(qf.ticket.id, { method: 'cash' });
Q.setStatus(qf.ticket.id, 'served');
ok(db.prepare('SELECT status FROM tickets WHERE id=?').get(qf.ticket.id).status === 'served', 'after paying, the queued order can be served');
// stale unpaid WAITING order is auto-voided by the sweep (queue-first)
const stale = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});
db.prepare("UPDATE tickets SET created_at=datetime('now','-60 minutes') WHERE id=?").run(stale.ticket.id);
Q.setPendingVoidMinutes(30);
const swept = Q.sweepStalePending({});
ok(swept.voided >= 1 && db.prepare('SELECT status FROM tickets WHERE id=?').get(stale.ticket.id).status === 'cancelled', `INVARIANT stale unpaid WAITING order auto-voids (swept ${swept.voided})`);
// The เข้าคิวทันที toggle must GOVERN numbering for EVERY channel (cashier + LINE) in BOTH states.
// (Prod report: orders piled into "รอชำระเงิน" under queue-first; numbering is now Turso-resilient.)
console.log('\n== Toggle governs queue numbering across all channels ==');
Q.setQueueFirst(true);
const onCash = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'cashier' });
const onLine = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Utoggle1' });
ok(onCash.ticket.number > 0 && onCash.ticket.status === 'waiting', `INVARIANT queue-first ON → cashier order numbered immediately (${onCash.ticket.number}/${onCash.ticket.status})`);
ok(onLine.ticket.number > 0 && onLine.ticket.status === 'waiting', `INVARIANT queue-first ON → LINE order numbered immediately (${onLine.ticket.number}/${onLine.ticket.status})`);
Q.setQueueFirst(false);
const offCash = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'cashier' });
const offLine = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Utoggle2' });
ok(offCash.ticket.number === 0 && offCash.ticket.status === 'pending', `INVARIANT pay-first OFF → cashier order waits in รอชำระเงิน, no number (${offCash.ticket.status})`);
ok(offLine.ticket.number === 0 && offLine.ticket.status === 'pending', `INVARIANT pay-first OFF → LINE order waits in รอชำระเงิน, no number (${offLine.ticket.status})`);
const offPaid = Q.setOrderPaid(offCash.ticket.id, { method: 'cash' });
ok(offPaid.number > 0 && db.prepare('SELECT status FROM tickets WHERE id=?').get(offCash.ticket.id).status === 'waiting', `INVARIANT paying a pay-first order then issues its number (${offPaid.number})`);

Q.setPendingVoidMinutes(0); Q.setQueueFirst(false);   // restore pay-first default for the archive checks

// ---- Customer cancel = sticky request; locks once the cashier starts making ----
console.log('\n== Customer cancel request + making lock ==');
Q.setQueueFirst(true);
const lc = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], { source: 'customer', lineUserId: 'Uowner1' });
Q.customerRequestCancel(lc.ticket.id, 'Uowner1');
ok(db.prepare('SELECT cancel_requested FROM tickets WHERE id=?').get(lc.ticket.id).cancel_requested != null, 'INVARIANT customer cancel raises a sticky request (does NOT auto-void)');
ok(db.prepare('SELECT status FROM tickets WHERE id=?').get(lc.ticket.id).status === 'waiting', 'order stays in the queue until the cashier confirms');
Q.dismissCancelRequest(lc.ticket.id);
ok(db.prepare('SELECT cancel_requested FROM tickets WHERE id=?').get(lc.ticket.id).cancel_requested == null, 'cashier "keep" clears the cancel request');
Q.startMaking(lc.ticket.id, {});
let madeLock = false; try { Q.customerRequestCancel(lc.ticket.id, 'Uowner1'); } catch (e) { madeLock = (e.message === 'already_making'); }
ok(madeLock, 'INVARIANT customer cannot cancel once the cashier started making');
let notMine = false; try { Q.customerRequestCancel(lc.ticket.id, 'Usomeone'); } catch (e) { notMine = ['not_your_order', 'already_making'].includes(e.message); }
ok(notMine, 'a different LINE user cannot cancel someone else’s order');
Q.setQueueFirst(false);

// ---- End-of-day archive must summarize the day exactly (sales_history ties to dailyReport) ----
console.log('\n== End-of-day archive ties out ==');
const eod = Q.dailyReport();
Q.archiveTodaySales();
const arow = db.prepare("SELECT * FROM sales_history WHERE date = date('now','+7 hours')").get();
ok(!!arow && near(arow.revenue, eod.revenue), `INVARIANT sales_history.revenue == dailyReport.revenue (${arow && arow.revenue} == ${eod.revenue})`);
ok(!!arow && arow.cups === eod.pnl.cups && near(arow.void_amount, eod.voided.amount), `archived cups + void amount tie out (cups ${arow && arow.cups}, void ${arow && arow.void_amount})`);
// Historical P&L: the archive also snapshots the cost breakdown, and salesHistory rolls up by year.
ok(!!arow && near(arow.cogs, eod.pnl.cogs) && near(arow.opex, eod.pnl.opexDaily), `archive snapshots the P&L breakdown (cogs ${arow && arow.cogs}, opex ${arow && arow.opex})`);
// Recovery path: backfilling by EXPLICIT date (the manual "บันทึกย้อนหลัง" + reconnect-retry that
// recover a night whose midnight auto-archive failed on a stale Turso stream).
const todayBkk = db.prepare("SELECT date('now','+7 hours') AS d").get().d;
const byDate = Q.archiveTodaySales(todayBkk);     // explicit-date path must equal the no-arg path
ok(byDate && near(byDate.revenue, eod.revenue), `archiveTodaySales(explicitDate) writes that day's row (${byDate && byDate.revenue} == ${eod.revenue})`);
const emptyRet = Q.archiveTodaySales('2020-01-02'); // a day with no sales → nothing saved, must not throw
ok(emptyRet === null && !db.prepare("SELECT 1 FROM sales_history WHERE date='2020-01-02'").get(), 'archiveTodaySales(emptyPastDate) saves nothing + does not throw');
const sh = Q.salesHistory();
ok(sh.daily.length >= 1 && Array.isArray(sh.weekly) && Array.isArray(sh.monthly) && Array.isArray(sh.yearly), 'salesHistory returns daily + weekly + monthly + yearly');
ok(sh.yearly.length >= 1 && near(sh.yearly[0].net, sh.daily.reduce((s, d) => s + (d.net || 0), 0)), 'INVARIANT yearly net rolls up the daily nets');
ok(sh.weekly.length >= 1 && near(sh.weekly.reduce((s, w) => s + (w.net || 0), 0), sh.daily.reduce((s, d) => s + (d.net || 0), 0)), 'INVARIANT weekly nets sum to the daily nets');

// ---- Menu reorder: arrange the order customers/cashier see (listMenu ORDER BY sort) ----
console.log('\n== Menu reorder ==');
const d1 = Q.addMenuItem({ name: 'ReorderA', price: 10, category: 'drink' });
const d2 = Q.addMenuItem({ name: 'ReorderB', price: 10, category: 'drink' });
const before = Q.listMenu().filter((m) => m.category !== 'topping').map((m) => m.id);
ok(before.indexOf(d1.id) < before.indexOf(d2.id), 'new items append in creation order (A before B)');
Q.moveMenuItem(d2.id, 'up');
const after = Q.listMenu().filter((m) => m.category !== 'topping').map((m) => m.id);
ok(after.indexOf(d2.id) < after.indexOf(d1.id), 'INVARIANT moveMenuItem(up) reorders the grid (B now before A)');
ok(Q.moveMenuItem(after[0], 'up').moved === false, 'INVARIANT moving the top item up is a no-op (edge)');

// ---- Free-badge giveaway: items/toppings flagged badge='free' are recorded at real price but an
// equal order-level discount nets them to ฿0. Server-authoritative (reads the menu badge). ----
console.log('\n== Free-badge giveaway (auto-discount) ==');
const fTop = Q.addMenuItem({ name: 'FreeTop', price: 15, category: 'topping', badge: 'free' });
const fg = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }, { name: 'FreeTop', price: 15, qty: 1 }], {});
const fgo = Q.orderForTicket(fg.ticket.id);
ok(near(fgo.discount, 15) && near(fgo.total - fgo.discount, 100), `INVARIANT a free-badged topping auto-discounts to ฿0 (discount ${fgo.discount}, net ${fgo.total - fgo.discount})`);
ok(fTop.id && db.prepare('SELECT price FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.ticket_id=? AND oi.name=?').get(fg.ticket.id, 'FreeTop').price === 15, 'free item is still RECORDED at real price (gross revenue stays accurate)');
// a free DRINK carries a sweetness suffix on the line name — the server must still match it
Q.addMenuItem({ name: 'FreeDrink', price: 40, category: 'drink', badge: 'free' });
const fg2 = Q.createOrder(1, [{ name: 'FreeDrink · หวาน 50%', price: 40, qty: 1 }, { name: 'Drink', price: 100, qty: 1 }], {});
const fgo2 = Q.orderForTicket(fg2.ticket.id);
ok(near(fgo2.discount, 40) && near(fgo2.total - fgo2.discount, 100), `INVARIANT a free drink at non-default sweetness still discounts (discount ${fgo2.discount}, net ${fgo2.total - fgo2.discount})`);
// paying settles at NET — the free portion is never collected
Q.setOrderPaid(fg.ticket.id, { method: 'cash' });
ok(db.prepare('SELECT total - COALESCE(discount,0) AS net FROM orders WHERE ticket_id=?').get(fg.ticket.id).net === 100, 'INVARIANT free-giveaway order settles at net (100)');
// editing to ADD a free item recomputes the giveaway discount; a plain order has none
const fe = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], {});
ok(near(Q.orderForTicket(fe.ticket.id).discount, 0), 'a plain order has no giveaway discount');
Q.editOrderItems(fe.ticket.id, [{ name: 'Drink', price: 100, qty: 1 }, { name: 'FreeTop', price: 15, qty: 1 }]);
ok(near(Q.orderForTicket(fe.ticket.id).discount, 15), 'INVARIANT editing to add a free item recomputes the giveaway discount (15)');

// ---- "เรียกแล้ว" strip: the snapshot must return MORE than 5 called tickets (the cashier UI shows
// 5 by default + a "แสดงทั้งหมด" toggle for the rest; the old LIMIT 5 hid the overflow entirely). ----
console.log('\n== Called list returns all (not capped at 5) ==');
const calledIds = [];
for (let i = 0; i < 7; i++) { const c = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {}); Q.setOrderPaid(c.ticket.id, { method: 'cash' }); calledIds.push(c.ticket.id); }
let calledN = 0, _c; while ((_c = Q.callNext(1)) && _c.called) calledN++;   // call every waiting ticket (callNext returns {called:null} when none left)
const snapCalled = Q.zoneSnapshot(1, { reveal: true }).recentCalled;
ok(calledN >= 7 && snapCalled.length >= 7, `INVARIANT snapshot returns ALL called tickets, not just 5 (called ${calledN}, snapshot ${snapCalled.length})`);
ok(snapCalled.length === snapCalled.filter((t) => t.order_total != null).length, 'every called ticket still carries its order detail');

// ---- CRM: customer profile by phone is computed LIVE from paid orders (visits, spend, favourites,
// history) — works retroactively, no maintained aggregates, independent of the loyalty toggle. ----
console.log('\n== CRM: customer profile by phone ==');
const crmPhone = '0812345678';
const crm1 = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }, { name: 'Topping', price: 10, qty: 1 }], {});
Q.attachCustomerToTicket(crm1.ticket.id, crmPhone, 'คุณเทส');
Q.setOrderPaid(crm1.ticket.id, { method: 'cash' });
const crm2 = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 2 }], {});
Q.attachCustomerToTicket(crm2.ticket.id, crmPhone);
Q.setOrderPaid(crm2.ticket.id, { method: 'cash' });
const prof = Q.lookupCustomerByPhone(crmPhone);
ok(prof.found && prof.visits === 2, `INVARIANT profile counts PAID visits (${prof.visits})`);
ok(near(prof.totalSpend, 160), `INVARIANT profile sums net spend across visits (${prof.totalSpend})`);
ok(prof.name === 'คุณเทส', `INVARIANT profile keeps the captured name (${prof.name})`);
ok(prof.favourites[0] && prof.favourites[0].name === 'Drink' && prof.favourites[0].qty === 3, `INVARIANT favourites rank base drinks by qty (Drink=${prof.favourites[0] && prof.favourites[0].qty})`);
ok(prof.recent.length === 2, `INVARIANT recent paid orders listed (${prof.recent.length})`);
ok(Q.lookupCustomerByPhone('0899999999').found === false, 'INVARIANT unknown phone → found:false');
let crmBad = null; try { Q.lookupCustomerByPhone('123'); } catch (e) { crmBad = e.message; }
ok(crmBad === 'bad_phone', `INVARIANT malformed phone rejected (${crmBad})`);
// The owner's customer report counts phone customers too (computed from real paid orders).
const ins = Q.customerInsights();
ok(ins.customers.repeat >= 1 && ins.customers.top.some((t) => t.isPhone && t.order_count === 2 && near(t.spend, 160)),
  `INVARIANT phone customer appears in repeat + top with real visits/spend (repeat ${ins.customers.repeat})`);
// Auto-recognition: a fresh order tagged to a RETURNING customer carries a mini-profile in the snapshot.
const recoT = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
Q.attachCustomerToTicket(recoT.ticket.id, crmPhone);
const recoSnap = Q.zoneSnapshot(1, { reveal: true });
const recoTk = [...(recoSnap.pending || []), ...(recoSnap.waiting || [])].find((x) => x.id === recoT.ticket.id);
ok(recoTk && recoTk.cust && recoTk.cust.visits === 2 && recoTk.cust.fav === 'Drink',
  `INVARIANT order card auto-recognises a returning customer (visits ${recoTk && recoTk.cust && recoTk.cust.visits}, fav ${recoTk && recoTk.cust && recoTk.cust.fav})`);
ok(!Q.zoneSnapshot(1, { reveal: false }).pending.some((x) => x.cust), 'INVARIANT recognition is cashier-only (not in the public snapshot)');

// ---- CRM win-back: targets ONLY lapsed LINE customers (recent or phone-only excluded) ----
console.log('\n== CRM: win-back targeting ==');
const luOld = 'Uoldcust0000000000000000000000001';
db.prepare('INSERT INTO customers (line_user_id, name) VALUES (?,?)').run(luOld, 'เก่า');
const wbO = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: luOld });
Q.setOrderPaid(wbO.ticket.id, { method: 'cash' });
db.prepare("UPDATE orders SET paid_at=datetime('now','-40 days') WHERE ticket_id=?").run(wbO.ticket.id);
const luNew = 'Unewcust0000000000000000000000002';
const wbN = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: luNew });
Q.setOrderPaid(wbN.ticket.id, { method: 'cash' });
db.prepare("UPDATE orders SET paid_at=datetime('now','-1 days') WHERE ticket_id=?").run(wbN.ticket.id);
const lapsed = Q.lapsedLineCustomers(30).map((c) => c.lineUserId);
ok(lapsed.includes(luOld) && !lapsed.includes(luNew), 'INVARIANT win-back targets lapsed LINE only (40-day in, 1-day out)');
ok(!Q.lapsedLineCustomers(1).some((c) => String(c.lineUserId).startsWith('tel:')), 'INVARIANT win-back never targets phone-only customers');
let wbEmpty = null; try { await Q.winBackBlast('   ', { days: 30 }); } catch (e) { wbEmpty = e.message; }
ok(wbEmpty === 'empty_message', `INVARIANT win-back rejects an empty message (${wbEmpty})`);

// ---- CRM QR check-in: cashier shows a per-order QR; the customer's scan claims (links) the order ----
console.log('\n== CRM: QR check-in handshake ==');
const ciT = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
const ciTok = Q.startCheckin(ciT.ticket.id);
const ciUser = 'Uclaimer000000000000000000000000001';
let ciBad = null; try { Q.claimTicket(ciT.ticket.id, ciUser, 'WRONGTOKEN'); } catch (e) { ciBad = e.message; }
ok(ciBad === 'bad_or_expired_qr', `INVARIANT claim rejects a wrong token (${ciBad})`);
const ciR = Q.claimTicket(ciT.ticket.id, ciUser, ciTok, 'สแกน');
ok(ciR.ok && db.prepare('SELECT line_user_id FROM tickets WHERE id=?').get(ciT.ticket.id).line_user_id === ciUser,
  'INVARIANT claim links the LINE identity to the ticket');
let ciTwice = null; try { Q.claimTicket(ciT.ticket.id, 'Uother', ciTok); } catch (e) { ciTwice = e.message; }
ok(ciTwice === 'bad_or_expired_qr' || ciTwice === 'already_claimed', `INVARIANT a used check-in token can't be replayed (${ciTwice})`);

// ---- "สั่งให้ลูกค้าคนนี้": tag a fresh order to a looked-up customer (phone or LINE) ----
console.log('\n== CRM: tag order to a looked-up customer ==');
const tagPhone = '0890001112';
const tg = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
Q.tagOrderCustomer(tg.ticket.id, 'tel:' + tagPhone, 'ใหม่');
Q.setOrderPaid(tg.ticket.id, { method: 'cash' });
const tgp = Q.lookupCustomerByPhone(tagPhone);
ok(tgp.found && tgp.visits === 1 && tgp.name === 'ใหม่', `INVARIANT tagging by phone ties the order to the customer (visits ${tgp.visits})`);
const tgL = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], {});
Q.tagOrderCustomer(tgL.ticket.id, 'Utagline0000000000000000000000001', 'LINE');
ok(db.prepare('SELECT line_user_id FROM tickets WHERE id=?').get(tgL.ticket.id).line_user_id === 'Utagline0000000000000000000000001', 'INVARIANT tagging by LINE id sets the ticket identity');

// ---- Cancelled-ticket contract: the LIFF collapses ALL pay affordances when a ticket is
//      cancelled, so the server payload must never look payable, and a SHOP reason must surface
//      to the customer in a safe (whitelisted) form. Guards the "green saved! box on a cancelled
//      order" regression. ----
console.log('\n== Cancelled-ticket contract (no contradictory pay state) ==');
const cx = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {});   // unpaid, pay-at-counter style
Q.cancelOrderTicket(cx.ticket.id, null, { reason: 'ของหมด/ทำไม่ได้' });
const cv = Q.ticketView(cx.ticket.id);
ok(cv.status === 'cancelled' && cv.canCancel === false && cv.making === false,
  `INVARIANT a cancelled ticket is never payable (status=${cv.status}, canCancel=${cv.canCancel}, making=${cv.making})`);
ok(cv.cancelReason === 'ขออภัยค่ะ เมนูนี้ของหมดพอดี 🙏',
  `INVARIANT shop cancel surfaces a customer-safe reason — got ${JSON.stringify(cv.cancelReason)}`);

const cx2 = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {});
Q.cancelOrderTicket(cx2.ticket.id, null, { reason: 'ของเสีย/ทำพลาด', kind: 'waste' });
ok(Q.ticketView(cx2.ticket.id).cancelReason === null,
  `INVARIANT internal void note never leaks to the customer — got ${JSON.stringify(Q.ticketView(cx2.ticket.id).cancelReason)}`);

const cx3 = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {});
db.prepare("UPDATE tickets SET cancel_requested=datetime('now') WHERE id=?").run(cx3.ticket.id);
Q.cancelOrderTicket(cx3.ticket.id, null, { reason: 'ลูกค้ายกเลิก' });
const cv3 = Q.ticketView(cx3.ticket.id);
ok(cv3.cancelRequested === true && cv3.cancelReason === null,
  `INVARIANT customer-requested cancel is by-request with no shop reason — got requested=${cv3.cancelRequested}, reason=${JSON.stringify(cv3.cancelReason)}`);

// ---- Closed-store gate: an order must be rejected server-side when the branch is outside its
//      opening hours, even though the zone toggle is still on (the member-card / deep-link bypass
//      the LIFF order button). Set hours to a weekday that is NOT today → definitely closed now. ----
console.log('\n== Closed-store order gate (server is the real door) ==');
const bkkDay = new Date(Date.now() + 7 * 3600 * 1000).getUTCDay();
Q.updateStore(1, { hoursDays: String((bkkDay + 1) % 7), hoursOpen: '08:00', hoursClose: '20:00' });   // open only on another day
let closedThrew = false;
try { Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {}); } catch (e) { closedThrew = e.message === 'store_closed'; }
ok(closedThrew, `INVARIANT off-hours order rejected server-side (store_closed) — threw=${closedThrew}`);
Q.updateStore(1, { hoursDays: '', hoursOpen: '', hoursClose: '' });   // clear hours → open again
let reopened = false;
try { const rr = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {}); reopened = !!(rr && rr.ticket); Q.cancelOrderTicket(rr.ticket.id, null, {}); } catch { reopened = false; }
ok(reopened, `INVARIANT clearing hours reopens ordering — got ${reopened}`);

// ---- Tender toggle drives the customer picker: /api/config derives payCounter/payOnline from the
//      ACTIVE tenders (listTenders(false)), so a toggled-off channel must leave that list. ----
console.log('\n== Payment tender toggle → active list (customer picker source) ==');
Q.addTender({ label: 'ZZ-online-test', kind: 'online' });
const ot = Q.listTenders(true).find((t) => t.label === 'ZZ-online-test');
ok(!!ot && Q.listTenders(false).some((t) => t.id === ot.id && t.kind === 'online'),
  'a new active online tender shows in the active list');
Q.updateTender(ot.id, { active: 0 });
ok(!Q.listTenders(false).some((t) => t.id === ot.id),
  'INVARIANT a toggled-off tender drops from the active list (LIFF picker filters by kind on this)');

try { rmSync(dir, { recursive: true, force: true }); } catch { /* DB file may be locked on Windows; harmless, it's gitignored */ }
console.log('\n' + (fail ? `❌ ${fail} FAILURE(S)` : '✅ ALL INVARIANTS HOLD'));
process.exit(fail ? 1 : 0);

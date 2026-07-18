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
// (source:'customer' — since the ขายนอกเวลา owner decision, only the customer path is gated)
try { Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], { source: 'customer', lineUserId: 'Uclosedgate0000000000000000001' }); } catch (e) { closedThrew = e.message === 'store_closed'; }
ok(closedThrew, `INVARIANT off-hours CUSTOMER order rejected server-side (store_closed) — threw=${closedThrew}`);
Q.updateStore(1, { hoursDays: '', hoursOpen: '', hoursClose: '' });   // clear hours → open again
let reopened = false;
try { const rr = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], {}); reopened = !!(rr && rr.ticket); Q.cancelOrderTicket(rr.ticket.id, null, {}); } catch { reopened = false; }
ok(reopened, `INVARIANT clearing hours reopens ordering — got ${reopened}`);

// ---- Coupon apply: the LIFF picker passes a code; createOrder re-validates SERVER-SIDE, applies the
//      discount, records the use, and enforces the per-customer limit. ----
console.log('\n== Coupon apply (server-enforced from the customer order) ==');
const ck = 'Ucouponcust000000000000000000001';
Q.createCoupon({ code: 'E2E50', label: 'ทดสอบ', disc_type: 'baht', disc_value: 50, min_spend: 0 });
const co = Q.createOrder(1, [{ name: 'Drink', price: 100, qty: 1 }], { source: 'customer', lineUserId: ck, couponCode: 'E2E50' });
const cord = db.prepare('SELECT discount FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(co.ticket.id);
ok(cord && Number(cord.discount) === 50, `INVARIANT coupon discount applied server-side — got ฿${cord && cord.discount}`);
ok(db.prepare('SELECT COUNT(*) n FROM coupon_uses WHERE customer_key=?').get(ck).n === 1, 'INVARIANT coupon use recorded once');
ok(Q.validateCoupon('E2E50', ck, 100).ok === false, 'INVARIANT per-customer limit blocks a second use');
ok(Q.validateCoupon('NOPE-NOT-REAL', ck, 100).ok === false, 'INVARIANT a fake code never validates');

// ---- Stamp-card reward surfaces as a self-service "coupon" once earned (owner ask: a customer
//      who reaches the threshold should see it in the SAME coupon list and be able to apply it
//      themselves, one at a time — not just via the cashier's manual "แลกฟรี" tap). ----
console.log('\n== Loyalty reward surfaces as a self-service coupon ==');
Q.setLoyaltyEnabled(true);
const rwCust = 'Urewardcust00000000000000000001';
// cup mode = 1 stamp/cup; qty 8 + the first-order welcome bonus (2) = 10 = the default reward's cost.
const rwSetup = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 8 }], { source: 'customer', lineUserId: rwCust });
Q.setOrderPaid(rwSetup.ticket.id, { method: 'cash' });
Q.setStatus(rwSetup.ticket.id, 'served');   // customer already picked this one up — free to place a new order
// Conversion model: completing the card SPENDS the 10 stamps immediately and issues a 30-day coupon.
const rwBal0 = Q.loyaltyBalance(rwCust).points;
ok(rwBal0 === 0, `INVARIANT the full card is spent into a coupon at completion (balance ${rwBal0})`);
const rwCoupons0 = Q.availableCoupons(rwCust, 100);
const rwCoupon = rwCoupons0.find((c) => c.isReward);
ok(!!rwCoupon && rwCoupon.code.startsWith('CCOUP:'), `INVARIANT the converted coupon surfaces in the coupon list — got ${JSON.stringify(rwCoupons0.map((c) => c.code))}`);
ok(rwCoupon && rwCoupon.freeCap === 49, `INVARIANT the reward coupon is capped at ฿49 (got ${rwCoupon && rwCoupon.freeCap})`);
// Selecting it (couponCode = "CCOUP:<id>") applies the free-drink discount at order time and marks
// the coupon used — no further points are touched (they were spent at conversion).
const rwOrder = Q.createOrder(1, [{ name: 'Drink', price: 49, qty: 1 }], { source: 'customer', lineUserId: rwCust, couponCode: rwCoupon.code });
const rwOrderRow = db.prepare('SELECT discount FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(rwOrder.ticket.id);
ok(rwOrderRow && Number(rwOrderRow.discount) > 0, `INVARIANT self-service coupon redemption discounts the order — got ฿${rwOrderRow && rwOrderRow.discount}`);
ok(Q.loyaltyBalance(rwCust).points === rwBal0, 'INVARIANT redeeming the coupon touches no further points');
ok(!Q.availableCoupons(rwCust, 100).find((c) => c.isReward), 'INVARIANT a used coupon drops off the list (no double-redeem)');
// A fully stamp-redeemed order (net ฿0) is paid with method='reward', which isn't a registered
// tender — confirm it still surfaces in the tender reconciliation report with a friendly label,
// not silently dropped from the owner's daily reconciliation.
const rwRecon = Q.tenderRecon();
const rwReconLine = rwRecon.lines.find((l) => l.code === 'reward');
ok(!!rwReconLine && rwReconLine.orders >= 1, `INVARIANT reward redemptions show up in tenderRecon (found=${!!rwReconLine}, orders=${rwReconLine && rwReconLine.orders})`);
ok(rwReconLine && rwReconLine.label === 'แลกด้วยแต้มสะสม (ฟรี)', `INVARIANT reward line has a friendly label, not the raw code — got ${JSON.stringify(rwReconLine && rwReconLine.label)}`);

// ---- Reward-celebration signal: a paid order that COMPLETES a stamp card (crosses a multiple of
//      `per`) sets ticketView().loyalty.rewardJustReady, so the LIFF can fire the celebration — but a
//      partial order does not, and it stays distinct from the first-order welcome. ----
console.log('\n== Reward celebration signal (stamp card completes) ==');
Q.setLoyaltyEnabled(true); Q.setEarnMode('cup'); Q.setWelcomeBonus(2); Q.setStampsPerReward(10);
const rjCust = 'Urewardjoy000000000000000000001';
const rj1 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 5 }], { source: 'customer', lineUserId: rjCust });
Q.setOrderPaid(rj1.ticket.id, { method: 'cash' });   // first order: 5 cups + 2 welcome = 7 stamps (no card completed yet)
const rjV1 = Q.ticketView(rj1.ticket.id);
ok(rjV1.loyalty && rjV1.loyalty.rewardJustReady === false, `INVARIANT a partial order does NOT fire the reward celebration (balance ${rjV1.loyalty && rjV1.loyalty.balance})`);
Q.setStatus(rj1.ticket.id, 'served');
const rj2 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 5 }], { source: 'customer', lineUserId: rjCust });
Q.setOrderPaid(rj2.ticket.id, { method: 'cash' });   // 7 -> 12 crosses the 10 boundary → a card completes
const rjV2 = Q.ticketView(rj2.ticket.id);
ok(rjV2.loyalty && rjV2.loyalty.rewardJustReady === true, `INVARIANT completing a stamp card fires the reward celebration (balance ${rjV2.loyalty && rjV2.loyalty.balance})`);
ok(rjV2.loyalty && rjV2.loyalty.firstOrder === false, 'INVARIANT the completion celebration is separate from the first-order welcome (bonus=0)');
// Conversion happens INSIDE the paid flow (12 → coupon + 2 left) — the celebration must survive it,
// since the boundary math runs on the balance as of this order's earns, not the live one.
ok(Q.loyaltyBalance(rjCust).points === 2, `INVARIANT the full card is spent into a coupon at completion (balance ${Q.loyaltyBalance(rjCust).points})`);
ok(Q.customerCoupons(rjCust).length === 1, 'INVARIANT completing a card converts into exactly 1 coupon');
const rjV2b = Q.ticketView(rj2.ticket.id);
ok(rjV2b.loyalty && rjV2b.loyalty.rewardJustReady === true, `INVARIANT the conversion itself doesn't cancel the celebration (bal now ${rjV2b.loyalty && rjV2b.loyalty.balance})`);

// Referral: on the invited friend's first order, awardPoints also logs the REFERRER's bonus under
// the SAME order_id — ticketView must not count that row into the friend's ticket.
const refOwner = 'Urefowner0000000000000000000001', refFriend = 'Ureffriend000000000000000000001';
const roSetup = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 1 }], { source: 'customer', lineUserId: refOwner });
Q.setOrderPaid(roSetup.ticket.id, { method: 'cash' }); Q.setStatus(roSetup.ticket.id, 'served');   // owner now has a referral identity
const refCode = Q.referralStatus(refOwner).code;
Q.applyReferralCode(refFriend, refCode);
const rfOrder = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 1 }], { source: 'customer', lineUserId: refFriend });
Q.setOrderPaid(rfOrder.ticket.id, { method: 'cash' });
const rfV = Q.ticketView(rfOrder.ticket.id);
ok(rfV.loyalty && rfV.loyalty.bonus === Q.getWelcomeBonus(),
  `INVARIANT the friend's ticket shows only THEIR welcome bonus, not the referrer's row (got ${rfV.loyalty && rfV.loyalty.bonus}, want ${Q.getWelcomeBonus()})`);
ok(rfV.loyalty && rfV.loyalty.firstOrder === true, 'INVARIANT a referred first order still counts as a first order');

// Birthday gift: a ฿100 free-drink coupon issued by the morning sweep, once per calendar year,
// visible in the coupon list and self-applicable. (The old auto "+10 stamps on a birthday order"
// is retired — the coupon IS the gift now.)
console.log('\n== Birthday coupon (morning sweep) ==');
const bdOld = 'Ubdayregular00000000000000000001';
const bo1 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 5 }], { source: 'customer', lineUserId: bdOld });
Q.setOrderPaid(bo1.ticket.id, { method: 'cash' }); Q.setStatus(bo1.ticket.id, 'served');   // an existing regular
const bkkMD = new Date(Date.now() + 7 * 3600e3).toISOString().slice(5, 10);
Q.setCustomerBirthday(bdOld, `${new Date().getUTCFullYear() - 20}-${bkkMD}`);   // birthday = today (20 years back)
const bdIssued = Q.issueBirthdayCoupons();
ok(bdIssued.issued >= 1, `INVARIANT the sweep issues a birthday coupon on the customer's birthday (issued ${bdIssued.issued})`);
const bdC = Q.customerCoupons(bdOld).find((c) => c.kind === 'birthday');
ok(!!bdC && bdC.free_cap === 100, `INVARIANT the birthday coupon is a free drink capped at ฿100 (got ${bdC && bdC.free_cap})`);
ok(Q.issueBirthdayCoupons().issued === 0, 'INVARIANT the sweep is idempotent — one birthday coupon per customer per year');
const bdBalBefore = Q.loyaltyBalance(bdOld).points;
const bdList = Q.availableCoupons(bdOld, 100).find((c) => c.couponKind === 'birthday');
ok(!!bdList, 'INVARIANT the birthday coupon shows in the customer coupon list');
const bdOrder = Q.createOrder(1, [{ name: 'Drink', price: 65, qty: 1 }], { source: 'customer', lineUserId: bdOld, couponCode: bdList.code });
const bdRow = db.prepare('SELECT discount, payment_status, payment_method FROM orders WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(bdOrder.ticket.id);
ok(bdRow && Number(bdRow.discount) === 65, `INVARIANT the birthday coupon covers a ฿65 drink in full (discount ฿${bdRow && bdRow.discount})`);
ok(Q.loyaltyBalance(bdOld).points >= bdBalBefore, 'INVARIANT using the birthday coupon never touches earned stamps');
// Cashier visibility: the customer profile panel lists the coupons the customer holds. (The
// birthday coupon was just spent above, so assert the array exists rather than its contents.)
ok(Array.isArray(Q.customerProfile(bdOld).coupons), 'INVARIANT the cashier customer panel exposes the coupons array');

// ---- Coupon 30-day window (conversion model): the coupon carries expiry = issue + 30 days; when
//      expired it's gone (owner policy) — remaining stamps are untouched. ----
console.log('\n== Coupon 30-day window ==');
const exCust = 'Uexpiry000000000000000000000001';
const exO1 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 10 }], { source: 'customer', lineUserId: exCust });
Q.setOrderPaid(exO1.ticket.id, { method: 'cash' }); Q.setStatus(exO1.ticket.id, 'served');   // 10 cups + 2 welcome = 12 → converts, 2 left
const exC1 = Q.availableCoupons(exCust, 100).find((c) => c.isReward);
const expWant = db.prepare("SELECT date(datetime('now','+7 hours'),'+30 days') d").get().d;
ok(!!exC1 && exC1.expires_at === expWant, `INVARIANT the coupon carries a 30-day expiry from conversion (got ${exC1 && exC1.expires_at}, want ${expWant})`);
const exBalBefore = Q.loyaltyBalance(exCust).points;
db.prepare("UPDATE customer_coupons SET expires_at=date('now','-1 day') WHERE customer_key=?").run(exCust);   // fast-forward past expiry
ok(!Q.availableCoupons(exCust, 100).find((c) => c.isReward), 'INVARIANT an expired coupon drops off the list');
const exO2 = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 1 }], { source: 'customer', lineUserId: exCust });
const exCCID = db.prepare('SELECT id FROM customer_coupons WHERE customer_key=?').get(exCust).id;
let exErr = null; try { Q.redeemCustomerCoupon(exO2.ticket.id, exCCID, null); } catch (e) { exErr = e.message; }
ok(exErr === 'coupon_expired', `INVARIANT redeeming an expired coupon is blocked (got ${exErr})`);
ok(Q.loyaltyBalance(exCust).points === exBalBefore, `INVARIANT expiry never claws back remaining stamps (still ${exBalBefore})`);

// ---- LINE push accounting: OA bills per message, so pushes are logged and countable. The UAT
//      stub (LINE disabled) must NOT log — it costs nothing. ----
console.log('\n== LINE push log / monthly stats ==');
const psBefore = Q.pushStats();
ok(Array.isArray(psBefore.monthly) && Array.isArray(psBefore.byKind) && typeof psBefore.today === 'number', 'INVARIANT pushStats returns monthly/byKind/today');
ok(db.prepare('SELECT COUNT(*) n FROM push_log').get().n === 0, 'INVARIANT the LINE stub logs nothing (no cost = no rows)');
db.prepare(`INSERT INTO push_log (user_id, kind, ok) VALUES ('Utest','winback',1), ('Utest','paid',1), ('Utest','winback',0)`).run();
const psAfter = Q.pushStats();
ok(psAfter.today === 3, `INVARIANT today's count reflects logged pushes (got ${psAfter.today})`);
ok(psAfter.monthly[0] && psAfter.monthly[0].n === 3 && psAfter.monthly[0].sent === 2, `INVARIANT monthly rollup counts attempts + successes (n=${psAfter.monthly[0] && psAfter.monthly[0].n}, sent=${psAfter.monthly[0] && psAfter.monthly[0].sent})`);
ok(psAfter.byKind.find((k) => k.kind === 'winback')?.n === 2, 'INVARIANT this-month breakdown by purpose works (winback=2)');
db.prepare('DELETE FROM push_log').run();

// ---- CRM: customer list segments + targeted campaign with attached coupon + campaign history ----
console.log('\n== CRM customers + targeted campaign ==');
const clAll = Q.customersList();
ok(Array.isArray(clAll) && clAll.length > 0, `customersList returns customers (got ${clAll.length})`);
ok(clAll.every((c) => ['new', 'regular', 'at_risk', 'lost'].includes(c.segment)), 'INVARIANT every customer gets a lifecycle segment');
const clTarget = clAll.find((c) => c.canPush && c.visits >= 1);
ok(!!clTarget, 'a pushable LINE customer exists for the campaign test');
const clCoupBefore = Q.customerCoupons(clTarget.key).length;
const camp = await Q.sendCampaign({ keys: [clTarget.key, 'tel:0812345678'], message: 'คิดถึงนะคะ', coupon: { label: 'คูปองคิดถึง', cap: 49, days: 14 }, actorId: null });
ok(camp.targeted === 1, `INVARIANT tel: keys are filtered out — only LINE customers targeted (got ${camp.targeted})`);
const clCoupAfter = Q.customerCoupons(clTarget.key);
ok(clCoupAfter.length === clCoupBefore + 1 && clCoupAfter.some((c) => c.kind === 'winback' && c.label === 'คูปองคิดถึง'), 'INVARIANT the attached coupon lands in the customer\'s coupon list (kind=winback)');
const campRow = Q.listCampaigns()[0];
ok(campRow && campRow.targeted === 1 && campRow.coupon_label === 'คูปองคิดถึง' && typeof campRow.sent === 'number', `INVARIANT campaign history persists targeted/sent/failed + coupon (targeted=${campRow && campRow.targeted}, sent=${campRow && campRow.sent})`);
let campErr = null; try { await Q.sendCampaign({ keys: ['tel:0800000000'], message: 'x' }); } catch (e) { campErr = e.message; }
ok(campErr === 'no_targets', `INVARIANT a campaign with no LINE-pushable targets is rejected (got ${campErr})`);

// ---- Cash-round history: closed Z-reports stay browsable daily + roll up monthly ----
console.log('\n== Cash round history ==');
Q.openCashSession(1, { openFloat: 500 });
const chClose = Q.closeCashSession(1, { countedCash: 700, note: 'ทดสอบ' });
const ch = Q.cashSessionHistory(1);
ok(ch.sessions.length >= 1 && ch.sessions[0].open_float === 500, `INVARIANT a closed round appears in the daily history (float ${ch.sessions[0] && ch.sessions[0].open_float})`);
ok(ch.sessions[0].expected_cash === chClose.expectedCash && ch.sessions[0].counted_cash === 700, 'INVARIANT the stored Z-report matches what the close returned');
ok(ch.lastFloat === 500, `INVARIANT lastFloat powers the "เท่ารอบก่อน" prefill (got ${ch.lastFloat})`);
const chM = ch.monthly[0];
ok(chM && chM.rounds >= 1 && chM.counted >= 700, `INVARIANT the monthly rollup aggregates rounds (rounds=${chM && chM.rounds}, counted=${chM && chM.counted})`);

// ---- Per-menu margin (BOM cost) + real COGS from the stock ledger ----
console.log('\n== Menu margins + real COGS ==');
const mmIng = db.prepare(`INSERT INTO ingredients (name, unit, stock_qty, avg_cost) VALUES ('นมทดสอบ','ลิตร', 100, 20)`).run();
const mmItem = db.prepare(`SELECT id, price FROM menu_items WHERE active=1 AND category!='topping' ORDER BY id LIMIT 1`).get();
db.prepare(`INSERT OR REPLACE INTO recipes (menu_item_id, ingredient_id, qty) VALUES (?,?,0.5)`).run(mmItem.id, mmIng.lastInsertRowid);
const mm = Q.menuMargins();
const mmRow = mm.find((i) => i.id === mmItem.id);
const rr = (x) => Math.round(x * 100) / 100;
ok(!!mmRow && mmRow.cost === 10 && mmRow.margin === rr(mmItem.price - 10), `INVARIANT margin = price − BOM cost (price ${mmItem.price}, cost ${mmRow && mmRow.cost}, margin ${mmRow && mmRow.margin})`);
ok(mm.some((i) => !i.hasRecipe), 'INVARIANT un-costed items are flagged hasRecipe:false');
const cogs0 = Q.cogsForDay().cogsActual;
Q.recordStockMove(mmIng.lastInsertRowid, { kind: 'use', qty: 2, note: 'ทดสอบ' });   // 2 × ฿20 = ฿40
const cogs1 = Q.cogsForDay().cogsActual;
ok(rr(cogs1 - cogs0) === 40, `INVARIANT real COGS reflects stock 'use' moves at avg cost (Δ ${rr(cogs1 - cogs0)})`);
Q.recordStockMove(mmIng.lastInsertRowid, { kind: 'return', qty: 2, note: 'คืนทดสอบ' });
ok(rr(Q.cogsForDay().cogsActual - cogs0) === 0, 'INVARIANT returns (cancelled orders) net out of real COGS');
db.prepare('DELETE FROM recipes WHERE ingredient_id=?').run(mmIng.lastInsertRowid);

// ---- A: auto closing summary (dedup once/day, only when enabled) ----
console.log('\n== Auto closing summary ==');
Q.setAutoSummary(false);
ok(Q.maybeAutoSummary().reason === 'off', 'INVARIANT auto-summary stays silent when disabled');
Q.setAutoSummary(true);
const sum1 = Q.maybeAutoSummary();   // no owner LINE id on UAT → sent:false but NOT 'off'/'already'
ok(sum1.reason !== 'off' && sum1.reason !== 'already', 'INVARIANT enabling auto-summary attempts a send');
ok(Q.maybeAutoSummary().reason === 'already', 'INVARIANT auto-summary fires at most once per day');
ok(typeof Q.composeDailySummary() === 'string' && Q.composeDailySummary().includes('สรุปยอดวันนี้'), 'INVARIANT the summary text composes');
Q.setAutoSummary(false);

// ---- D: auto-draft PO from the plan (once/day, drafts only — never auto-receives) ----
console.log('\n== Auto reorder ==');
Q.setAutoReorder(false);
ok(Q.maybeAutoReorder().reason === 'off', 'INVARIANT auto-reorder stays silent when disabled');
// make something clearly need reordering
const arIng = db.prepare(`INSERT INTO ingredients (name, unit, stock_qty, avg_cost, low_threshold) VALUES ('วัตถุดิบสั่งซื้ออัตโนมัติ','กก.', 1, 20, 5)`).run().lastInsertRowid;
Q.recordStockMove(arIng, { kind: 'use', qty: 40, note: 'ใช้หนักจำลอง' });   // heavy usage → plan flags it
Q.setAutoReorder(true);
const ar = Q.maybeAutoReorder();
ok(ar.drafted === true && /^PO-/.test(ar.poNo), `INVARIANT auto-reorder drafts a PO when stock is low (po ${ar.poNo})`);
const arPo = Q.getPurchaseOrder(ar.poId);
ok(arPo && arPo.status === 'draft', 'INVARIANT the auto-drafted PO is a DRAFT (owner still confirms — no silent stock change)');
ok(Q.maybeAutoReorder().reason === 'already', 'INVARIANT auto-reorder drafts at most once per day');
Q.setAutoReorder(false);

// ---- Customer list carries the star rating each customer gave + exports to Excel ----
console.log('\n== Customer ratings + Excel export ==');
{
  const rkey = 'Urating0000000000000000000001';
  db.prepare(`INSERT OR IGNORE INTO customers (line_user_id, name) VALUES (?, 'ลูกค้าให้ดาว')`).run(rkey);
  const t1 = db.prepare(`INSERT INTO tickets (store_id, zone_id, number, code, line_user_id, status, customer_name, rating) VALUES (1,1,801,'RT801',?, 'served','ลูกค้าให้ดาว', 5)`).run(rkey);
  db.prepare(`INSERT INTO orders (ticket_id, total, payment_status, paid_at, branch_id) VALUES (?, 60, 'paid', datetime('now'), 1)`).run(t1.lastInsertRowid);
  const t2 = db.prepare(`INSERT INTO tickets (store_id, zone_id, number, code, line_user_id, status, customer_name, rating) VALUES (1,1,802,'RT802',?, 'served','ลูกค้าให้ดาว', 3)`).run(rkey);
  db.prepare(`INSERT INTO orders (ticket_id, total, payment_status, paid_at, branch_id) VALUES (?, 60, 'paid', datetime('now'), 1)`).run(t2.lastInsertRowid);
  const rc = Q.customersList().find((c) => c.key === rkey);
  ok(rc && rc.ratingAvg === 4 && rc.ratingCount === 2, `INVARIANT a customer's given-rating avg + count are in the list (avg ${rc && rc.ratingAvg}, n ${rc && rc.ratingCount})`);
  const { buildCustomersWorkbook } = await import('../server/report-excel.js');
  const buf = await buildCustomersWorkbook(Q.customersList(), { store: 'TEST' });
  ok(buf && buf.byteLength > 500, `INVARIANT the customers workbook builds a non-trivial xlsx (${buf && buf.byteLength} bytes)`);
}

// ---- C: auto win-back for at-risk customers (capped + cooldown) ----
console.log('\n== Auto win-back ==');
Q.setAutoWinback(false);
ok((await Q.maybeAutoWinback()).reason === 'off', 'INVARIANT auto-winback stays silent when disabled');
// craft an at-risk LINE customer: 2 paid visits, the latest ~45 days ago (needs >1 visit to leave 'new')
const awKey = 'Uautowinback000000000000000001';
db.prepare(`INSERT OR IGNORE INTO customers (line_user_id, name) VALUES (?, 'ลูกค้าห่างหาย')`).run(awKey);
for (const [num, code, ago] of [[776, 'AW776', '-70 days'], [777, 'AW777', '-45 days']]) {
  const tk = db.prepare(`INSERT INTO tickets (store_id, zone_id, number, code, line_user_id, status, customer_name) VALUES (1,1,?,?,?, 'served','ลูกค้าห่างหาย')`).run(num, code, awKey);
  db.prepare(`INSERT INTO orders (ticket_id, total, payment_status, paid_at, branch_id) VALUES (?, 100, 'paid', datetime('now',?), 1)`).run(tk.lastInsertRowid, ago);
}
const awSeg = Q.customersList().find((c) => c.key === awKey);
ok(awSeg && awSeg.segment === 'at_risk', `INVARIANT the 45-day-lapsed customer is segmented at_risk (got ${awSeg && awSeg.segment})`);
Q.setAutoWinback(true); Q.setAutoWinbackCap(100);
const aw1 = await Q.maybeAutoWinback();
ok(aw1.reason === 'ok' && aw1.targeted >= 1, `INVARIANT auto-winback targets at-risk LINE customers (targeted ${aw1.targeted})`);
ok(db.prepare(`SELECT 1 FROM customer_coupons WHERE customer_key=? AND kind='winback'`).get(awKey), 'INVARIANT the at-risk customer received a win-back coupon');
ok((await Q.maybeAutoWinback()).reason === 'already', 'INVARIANT auto-winback runs at most once per day');
// cap of 0 blocks sends
db.prepare("UPDATE settings SET value='' WHERE key='winback:last_run'").run();   // clear day-dedup to test the cap path
Q.setAutoWinbackCap(0);
ok((await Q.maybeAutoWinback()).reason === 'cap', 'INVARIANT the monthly cap blocks further sends when reached');
Q.setAutoWinback(false);

// ---- Waste is recorded distinctly from use (so COGS vs waste cost are separable) ----
const wIng = db.prepare(`INSERT INTO ingredients (name, unit, stock_qty, avg_cost) VALUES ('วัตถุดิบของเสีย','กก.', 20, 10)`).run().lastInsertRowid;
const cogsW0 = Q.cogsForDay();
Q.recordStockMove(wIng, { kind: 'use', qty: 2, note: 'เบิกใช้' });     // 2×10 = ฿20 COGS
Q.recordStockMove(wIng, { kind: 'waste', qty: 1, note: 'ของเสีย' });   // 1×10 = ฿10 waste
const cogsW1 = Q.cogsForDay();
ok(Math.round((cogsW1.cogsActual - cogsW0.cogsActual) * 100) / 100 === 20, `INVARIANT a 'use' move feeds COGS, not waste (Δcogs ${Math.round((cogsW1.cogsActual - cogsW0.cogsActual) * 100) / 100})`);
ok(Math.round((cogsW1.wasteCost - cogsW0.wasteCost) * 100) / 100 === 10, `INVARIANT a 'waste' move feeds wasteCost separately (Δwaste ${Math.round((cogsW1.wasteCost - cogsW0.wasteCost) * 100) / 100})`);
ok(db.prepare("SELECT stock_qty FROM ingredients WHERE id=?").get(wIng).stock_qty === 17, 'INVARIANT both use and waste deduct on-hand stock');

// ---- Suppliers + price history + purchase planning ----
console.log('\n== Suppliers + purchase planning ==');
const sup = Q.upsertSupplier(null, { name: 'แม็คโครทดสอบ', phone: '021112222', note: 'ส่งวันอังคาร' });
ok(sup.id > 0 && Q.listSuppliers().some((s) => s.id === sup.id), 'INVARIANT a supplier can be created and listed');
// buy 10 units for ฿300 from that supplier → unit price ฿30 in the history
Q.recordStockMove(mmIng.lastInsertRowid, { kind: 'purchase', qty: 10, cost: 300, supplierId: sup.id });
const ph = Q.ingredientPriceHistory(mmIng.lastInsertRowid);
ok(ph.length >= 1 && ph[0].unitPrice === 30 && ph[0].supplier === 'แม็คโครทดสอบ', `INVARIANT price history shows who/when/unit-price (got ฿${ph[0] && ph[0].unitPrice} from ${ph[0] && ph[0].supplier})`);
// heavy usage → the plan must suggest reordering: use 70 over "14 days" ⇒ 5/day; stock left low
const planIngBefore = db.prepare('SELECT stock_qty FROM ingredients WHERE id=?').get(mmIng.lastInsertRowid).stock_qty;
Q.recordStockMove(mmIng.lastInsertRowid, { kind: 'use', qty: planIngBefore - 3, note: 'จำลองใช้หนัก' });   // leave 3 on hand
const plan = Q.purchasePlan();
const pRow = plan.find((p) => p.id === mmIng.lastInsertRowid);
ok(!!pRow && pRow.perDay > 0 && pRow.daysLeft != null && pRow.suggestQty > 0, `INVARIANT heavy usage yields a reorder suggestion (perDay ${pRow && pRow.perDay}, daysLeft ${pRow && pRow.daysLeft}, suggest ${pRow && pRow.suggestQty})`);
ok(pRow.lastSupplier === 'แม็คโครทดสอบ' && pRow.lastUnitPrice === 30, 'INVARIANT the plan carries last supplier + last unit price for the call');
ok(plan[0].id === pRow.id || (plan[0].daysLeft ?? 9e9) <= (pRow.daysLeft ?? 9e9), 'INVARIANT plan is sorted most-urgent first');
Q.upsertSupplier(sup.id, { active: 0 });
ok(!Q.listSuppliers().some((s) => s.id === sup.id), 'INVARIANT a deactivated supplier leaves the list (history kept)');

// ---- Owner decisions: sell outside hours (cashier only) + audited cash-move deletion ----
console.log('\n== Off-hours selling + cash-delete audit ==');
// Close the store manually, then try both order sources.
db.prepare('UPDATE stores SET is_open=0 WHERE id=1').run();
const zoneRow = db.prepare('SELECT id FROM zones WHERE store_id=1 LIMIT 1').get();
let custErr = null;
try { Q.createOrder(zoneRow.id, [{ name: 'ทดสอบนอกเวลา', price: 10, qty: 1 }], { source: 'customer', lineUserId: 'Uoffhours0000000000000000000001' }); }
catch (e) { custErr = e.message; }
ok(custErr === 'store_closed', `INVARIANT a LINE customer still cannot order while closed (got ${custErr})`);
const posOrder = Q.createOrder(zoneRow.id, [{ name: 'ทดสอบนอกเวลา', price: 10, qty: 1 }], { source: 'cashier' });
ok(!!posOrder && posOrder.total === 10, 'INVARIANT the cashier POS can sell while the store is closed (ขายนอกเวลา)');
db.prepare('UPDATE stores SET is_open=1 WHERE id=1').run();
// Deleting a pay-in/out row must land in the ควบคุมการลดยอด audit trail.
const cmRow = Q.addCashMove(1, 'pay_out', 250, 'ค่าน้ำแข็งทดสอบ', null);
Q.deleteCashMove(cmRow.id, 1, null);
await new Promise((r) => setImmediate(r));   // sale_events flush is batched on setImmediate
const redu = Q.listReductions(1);
const delEv = redu.events.find((e) => e.type === 'cash_delete' && e.amount === 250);
ok(!!delEv, 'INVARIANT deleting a cash move is recorded as a cash_delete reduction event');
ok(delEv && /จ่ายออก/.test(delEv.reason || '') && /ค่าน้ำแข็งทดสอบ/.test(delEv.reason || ''), `INVARIANT the audit row describes the deleted entry (got "${delEv && delEv.reason}")`);
ok(redu.byType.cash_delete >= 250, 'INVARIANT cash_delete gets its own byType total for the tile');

// ---- Push-stats date range (LINE cost report: จากวัน X ถึงวัน X) ----
const psToday = db.prepare("SELECT date(datetime('now','+7 hours')) d").get().d;
const psr = Q.pushStatsRange(psToday, psToday);
const psAll = Q.pushStats();
ok(psr.from === psToday && psr.to === psToday && psr.total === psAll.today, `INVARIANT range report for today matches pushStats.today (${psr.total} vs ${psAll.today})`);
ok(Q.pushStatsRange('bad-date', null).from !== 'bad-date', 'INVARIANT malformed range dates fall back to defaults');

// ---- SCM: purchase orders, expiry lots, two-way sourcing ----
console.log('\n== SCM: purchase orders + sourcing ==');
const scmIng = db.prepare(`INSERT INTO ingredients (name, unit, stock_qty, avg_cost) VALUES ('วัตถุดิบ SCM','กก.', 0, 0)`).run().lastInsertRowid;
const scmSupA = Q.upsertSupplier(null, { name: 'ผู้ขาย A' });
const scmSupB = Q.upsertSupplier(null, { name: 'ผู้ขาย B' });
// Draft a PO, then receive it → posts stock + expiry lot
const draft = Q.savePurchaseOrder({ supplierId: scmSupA.id, note: 'ทดสอบ', lines: [
  { ingredientId: scmIng, qty: 10, unitPrice: 25, expiry: '2026-08-31' },
  { ingredientId: scmIng, qty: 0, unitPrice: 5 },   // qty 0 → dropped
] });
ok(draft.po_no && /^PO-\d{4}-\d{4}$/.test(draft.po_no) && draft.lines.length === 1 && draft.total === 250, `INVARIANT a draft PO auto-numbers + totals valid lines (no ${draft.po_no}, total ${draft.total})`);
const stockBeforePO = db.prepare('SELECT stock_qty FROM ingredients WHERE id=?').get(scmIng).stock_qty;
const recv = Q.receivePurchaseOrder(draft.id);
ok(recv.status === 'received', 'INVARIANT receiving a PO marks it received');
const stockAfterPO = db.prepare('SELECT stock_qty FROM ingredients WHERE id=?').get(scmIng).stock_qty;
ok(rr(stockAfterPO - stockBeforePO) === 10, `INVARIANT receiving posts stock (Δ ${rr(stockAfterPO - stockBeforePO)})`);
let reRecv = null; try { Q.receivePurchaseOrder(draft.id); } catch (e) { reRecv = e.message; }
ok(reRecv === 'po_not_draft', 'INVARIANT a received PO cannot be received again (no double-posting)');
let editRecv = null; try { Q.savePurchaseOrder({ id: draft.id, lines: [] }); } catch (e) { editRecv = e.message; }
ok(editRecv === 'po_not_editable', 'INVARIANT a received PO is immutable');
// Expiry lot surfaces in the alert window
const exp = Q.expiringLots(400);   // 2026-08-31 is within a wide window relative to test clock
ok(exp.some((l) => l.expiry === '2026-08-31' && l.name === 'วัตถุดิบ SCM'), 'INVARIANT a received lot with an expiry appears in expiringLots');
// Two-way sourcing: buy the same item from supplier B too, then check both views
Q.recordStockMove(scmIng, { kind: 'purchase', qty: 10, cost: 300, supplierId: scmSupB.id });   // ฿30/unit
const srcs = Q.ingredientSources(scmIng);
ok(srcs.sources.length === 2, `INVARIANT ingredientSources lists every supplier the item was bought from (got ${srcs.sources.length})`);
ok(srcs.cheapest && srcs.cheapest.supplier === 'ผู้ขาย A' && srcs.cheapest.avgUnit === 25, `INVARIANT cheapest source is identified (got ${srcs.cheapest && srcs.cheapest.supplier} @${srcs.cheapest && srcs.cheapest.avgUnit})`);
const cat = Q.supplierCatalog(scmSupA.id);
ok(cat.items.some((i) => i.id === scmIng && i.avgUnit === 25) && cat.orders.some((o) => o.id === draft.id), 'INVARIANT supplierCatalog shows what they sold + their PO history');
// Cancel guard
const draft2 = Q.savePurchaseOrder({ supplierId: scmSupA.id, lines: [{ ingredientId: scmIng, qty: 1, unitPrice: 1 }] });
ok(Q.cancelPurchaseOrder(draft2.id).ok === true, 'INVARIANT a draft PO can be cancelled');
let cancelRecv = null; try { Q.cancelPurchaseOrder(draft.id); } catch (e) { cancelRecv = e.message; }
ok(cancelRecv === 'po_already_received', 'INVARIANT a received PO cannot be cancelled');
// ---- OCR receipt → PO line matching (pure mapper, vision call stays dormant) ----
console.log('\n== Receipt OCR line matching ==');
const ocrIngs = [{ id: 1, name: 'โยเกิร์ตรสธรรมชาติ', unit: 'กก.' }, { id: 2, name: 'สตรอเบอร์รี่แช่แข็ง', unit: 'กก.' }];
const ocrParsed = [
  { name: 'โยเกิร์ตรสธรรมชาติ', qty: 5, unitPrice: 53, expiry: '2026-09-01' }, // exact
  { name: 'สตรอเบอร์รี่', qty: 2, unitPrice: 80 },                              // substring
  { name: 'ของแปลกไม่รู้จัก', qty: 1, unitPrice: 10 },                          // no match
];
const matched = Q.matchReceiptLines(ocrParsed, ocrIngs);
ok(matched[0].ingredientId === 1 && matched[0].expiry === '2026-09-01', 'INVARIANT OCR exact name maps to the ingredient + keeps expiry');
ok(matched[1].ingredientId === 2 && matched[1].matched === true, 'INVARIANT OCR partial name still matches by substring');
ok(matched[2].ingredientId === null && matched[2].matched === false, 'INVARIANT an unrecognized line is flagged for manual pick, not dropped');
ok(Q.matchReceiptLines([{ name: 'x', qty: -5, unitPrice: -1, expiry: 'bad' }], ocrIngs)[0].qty === 0, 'INVARIANT OCR line qty/price are clamped, bad expiry nulled');
ok(Q.ocrConfigured() === false, 'INVARIANT OCR vision call is dormant without OCR_API_URL/KEY (safe default)');
let ocrOff = null; try { await Q.parseReceiptImage('data:image/png;base64,abc'); } catch (e) { ocrOff = e.message; }
ok(ocrOff === 'ocr_off', 'INVARIANT parseReceiptImage refuses when unconfigured (no accidental external call)');
// OCR learns: teach an alias, then the same wording auto-matches next time
Q.learnAlias('นมสดยี่ห้อพิเศษ', ocrIngs[0].id);
const relearned = Q.matchReceiptLines([{ name: 'นมสดยี่ห้อพิเศษ', qty: 1, unitPrice: 5 }], ocrIngs, Q.aliasMap());
ok(relearned[0].ingredientId === ocrIngs[0].id && relearned[0].viaAlias === true, 'INVARIANT a learned alias makes an otherwise-unmatched wording auto-match (viaAlias)');
Q.learnAlias('นมสดยี่ห้อพิเศษ', ocrIngs[1].id);   // correction overwrites
ok(Q.aliasMap()[('นมสดยี่ห้อพิเศษ')] === ocrIngs[1].id, 'INVARIANT correcting an alias overwrites the old mapping');

// ---- Slip-OCR learning: cashier teaches per-bank receiver wordings ----
console.log('\n== Slip receiver aliases ==');
Q.addSlipAlias('ธรรมนูญ ก. (KBANK)');
ok(Q.listSlipAliases().includes('ธรรมนูญ ก. (KBANK)'), 'INVARIANT a taught receiver alias persists');
Q.addSlipAlias('ธรรมนูญ  ก. (kbank)');   // same after normalization → no duplicate
ok(Q.listSlipAliases().length === 1, `INVARIANT near-duplicate aliases are deduped (got ${Q.listSlipAliases().length})`);
let aShort = null; try { Q.addSlipAlias('ab'); } catch (e) { aShort = e.message; }
ok(aShort === 'alias_too_short', 'INVARIANT too-short alias rejected');
for (let i = 0; i < 35; i++) Q.addSlipAlias('ผู้รับทดสอบหมายเลข ' + i);
ok(Q.listSlipAliases().length <= 30, `INVARIANT alias list is capped at 30 (got ${Q.listSlipAliases().length})`);

// ---- Purchasing report: monthly / per-item / per-supplier spend ----
console.log('\n== Purchase report ==');
const prIng = db.prepare(`INSERT INTO ingredients (name, unit) VALUES ('วัตถุดิบรายงาน','กก.')`).run().lastInsertRowid;
const prSup = Q.upsertSupplier(null, { name: 'ผู้ขายรายงาน' });
Q.recordStockMove(prIng, { kind: 'purchase', qty: 4, cost: 400, supplierId: prSup.id });   // ฿400
const pr = Q.purchaseSummary();
ok(pr.byItem.some((r) => r.name === 'วัตถุดิบรายงาน' && r.spent === 400 && r.avgUnit === 100), 'INVARIANT purchase report breaks spend down per item with avg unit price');
ok(pr.bySupplier.some((r) => r.supplier === 'ผู้ขายรายงาน' && r.spent >= 400), 'INVARIANT purchase report breaks spend down per supplier');
ok(pr.byMonth.length >= 1 && pr.byMonth[0].spent >= 400, 'INVARIANT purchase report rolls up by month');
ok(Q.purchaseSummary('2000-01-01', '2000-01-02').total === 0, 'INVARIANT an empty date range totals zero');

db.prepare('DELETE FROM recipes WHERE ingredient_id=?').run(scmIng);

// ---- Owner toggles: social-proof + mascot default OFF, flip independently, and soldTodayCount
//      reflects paid drinks sold today (drives the LIFF "วันนี้ขายไปแล้ว N แก้ว" line). ----
console.log('\n== Owner toggles (social proof + mascot) ==');
ok(Q.socialProofEnabled() === false && Q.mascotEnabled() === false, 'INVARIANT social-proof + mascot both default OFF');
Q.setSocialProof(true); Q.setMascot(true);
ok(Q.socialProofEnabled() === true && Q.mascotEnabled() === true, 'INVARIANT both toggles flip on');
Q.setSocialProof(false);
ok(Q.socialProofEnabled() === false && Q.mascotEnabled() === true, 'INVARIANT toggles are independent');
const soldBefore = Q.soldTodayCount();
const spOrder = Q.createOrder(1, [{ name: 'Drink', price: 40, qty: 2 }], { source: 'customer', lineUserId: 'Usoldtoday00000000000000000001' });
Q.setOrderPaid(spOrder.ticket.id, { method: 'cash' });
const soldAfter = Q.soldTodayCount();
ok(soldAfter === soldBefore + 2, `INVARIANT soldTodayCount counts paid drinks sold today (${soldBefore} -> ${soldAfter})`);
Q.setMascot(false);   // leave settings off so later tests / the shipped default are clean

// ---- Birthday capture: date-of-birth can't be in the future, and can't be within the last year
//      either (a customer entering their OWN birthday to order themselves can't be that young —
//      almost certainly a mistyped year). Both give a specific, distinguishable error reason. ----
console.log('\n== Birthday validation (future + too-recent dates rejected) ==');
const bdCust = 'Ubdaytest0000000000000000000001';
const futureDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);   // +2d clears the UTC/Bangkok (+7h) date-boundary overlap
let bdErr = null;
try { Q.setCustomerBirthday(bdCust, futureDate); } catch (e) { bdErr = e.message; }
ok(bdErr === 'future_birthday', `INVARIANT a future birthday is rejected with a specific reason — got ${bdErr}`);
const recentDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);   // 30 days ago
bdErr = null;
try { Q.setCustomerBirthday(bdCust, recentDate); } catch (e) { bdErr = e.message; }
ok(bdErr === 'birthday_too_recent', `INVARIANT a birthday within the last year is rejected — got ${bdErr}`);
const validDate = '1995-06-15';
const bdSaved = Q.setCustomerBirthday(bdCust, validDate);
ok(bdSaved.ok === true && bdSaved.birthday === validDate, 'INVARIANT a birthday over a year old saves fine');

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

// ---- "พร้อมรับ" trigger: finishing every drink line marks the order ready + notifies the customer,
//      but only when it's PAID (never announce before payment). ----
console.log('\n== Ready (พร้อมรับ) per-ticket trigger ==');
const rt = sale({ items: [{ name: 'Drink', price: 50, qty: 1 }], method: 'cash' });   // paid
ok(Q.markReady(rt, 5).ok === true, 'paid order can be marked พร้อมรับ');
ok(db.prepare('SELECT status FROM tickets WHERE id=?').get(rt).status === 'called', 'INVARIANT ready sets status=called (พร้อมรับ)');
ok(Q.markReady(rt, 5).already === true, 'INVARIANT ready is idempotent (announced once)');
const upr = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Ureadytest0000000000000000000001' });
ok(Q.markReady(upr.ticket.id, 5).reason === 'unpaid', 'INVARIANT an unpaid order is never announced ready');

// ---- Preliminary slip check (free): the SAME slip image reused on another order is flagged. ----
console.log('\n== Slip preliminary check (duplicate image) ==');
const sd1 = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Uslip00000000000000000000000001' });
const sd2 = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Uslip00000000000000000000000002' });
Q.attachSlip(sd1.ticket.id, 'data:image/png;base64,SAMESLIPIMAGE');
Q.attachSlip(sd2.ticket.id, 'data:image/png;base64,SAMESLIPIMAGE');   // reused → duplicate
ok(Q.slipPrelim(sd2.ticket.id).duplicate != null, 'INVARIANT a reused slip image is flagged as duplicate');
const sd3 = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Uslip00000000000000000000000003' });
Q.attachSlip(sd3.ticket.id, 'data:image/png;base64,UNIQUESLIPIMAGE');
ok(Q.slipPrelim(sd3.ticket.id).duplicate == null, 'INVARIANT a unique slip is not flagged');
ok(Q.slipPrelim(sd3.ticket.id).expectedAmount === 50, 'INVARIANT prelim hands the cashier the expected amount');

// ---- Menu "likes" = distinct identifiable customers who bought the item (customer card heart). ----
console.log('\n== Menu likes (distinct customers) ==');
const lk = Q.createOrder(1, [{ name: 'Drink', price: 50, qty: 1 }], { source: 'customer', lineUserId: 'Ulikes000000000000000000000001' });
Q.setOrderPaid(lk.ticket.id, { method: 'cash' });
const drinkRow = Q.listMenu().find((m) => m.name === 'Drink');
ok(drinkRow && drinkRow.likes >= 1, `INVARIANT a paid order by an identifiable customer counts as a like (got ${drinkRow && drinkRow.likes})`);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* DB file may be locked on Windows; harmless, it's gitignored */ }
console.log('\n' + (fail ? `❌ ${fail} FAILURE(S)` : '✅ ALL INVARIANTS HOLD'));
process.exit(fail ? 1 : 0);

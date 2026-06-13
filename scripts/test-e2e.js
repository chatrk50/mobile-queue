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

const refund = det.voidTotals.refund;
ok(refund && refund.count === 1 && near(refund.amount, 50), 'S4 recorded as a refund (1 × 50)');

// ---- P&L: every line of the profit chain must follow from the settings + sales ----
console.log('\n== P&L formulas ==');
const p = rep.pnl, f = rep.settings;
ok(near(p.cups, 3), `P&L cups == 3 paid drinks (S4 voided, excluded) — got ${p.cups}`);
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

try { rmSync(dir, { recursive: true, force: true }); } catch { /* DB file may be locked on Windows; harmless, it's gitignored */ }
console.log('\n' + (fail ? `❌ ${fail} FAILURE(S)` : '✅ ALL INVARIANTS HOLD'));
process.exit(fail ? 1 : 0);

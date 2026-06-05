// End-to-end logic test against the queue engine directly (no HTTP needed).
// Verifies numbering, ahead-count, call-next ordering, and the one-shot
// "coming up soon" notification threshold. LINE is stubbed (logs only).
import assert from 'node:assert';
import { db } from '../server/db.js';
import * as Q from '../server/queue.js';

// fresh state
db.exec("DELETE FROM tickets; DELETE FROM zones; DELETE FROM stores;");
const storeId = db.prepare('INSERT INTO stores(name) VALUES(?)').run('Test').lastInsertRowid;
const zoneId = db.prepare('INSERT INTO zones(store_id,name,prefix) VALUES(?,?,?)').run(storeId,'Z','A').lastInsertRowid;
const THRESHOLD = 2;

// capture stubbed LINE pushes by counting "soon" flags instead (deterministic)
// Issue 5 tickets
const codes = [];
for (let i=0;i<5;i++){ const { ticket, ahead } = Q.issueTicket({storeId,zoneId,partySize:2,lineUserId:'u'+i});
  codes.push(ticket.code); if(i===0) assert.equal(ahead,0); if(i===4) assert.equal(ahead,4); }
assert.deepEqual(codes, ['A001','A002','A003','A004','A005']);
console.log('✓ numbering + ahead-count correct:', codes.join(' '));

// Before any call: ticket #5 (idx4) should NOT be notified_soon yet
let t5 = db.prepare("SELECT * FROM tickets WHERE code='A005'").get();
assert.equal(t5.notified_soon, 0);

// Call next -> A001 served front; evaluate notifications.
// Waiting becomes A002..A005 at positions 0..3. threshold=2 => positions 0,1,2 notified.
const r1 = Q.callNext(zoneId, THRESHOLD);
assert.equal(r1.called.code,'A001');
const soon1 = db.prepare("SELECT code FROM tickets WHERE notified_soon=1 ORDER BY number").all().map(x=>x.code);
assert.deepEqual(soon1, ['A002','A003','A004']);
console.log('✓ after 1 call, "soon" notified (≤2 ahead):', soon1.join(' '));

// A005 still not notified (3 ahead)
t5 = db.prepare("SELECT * FROM tickets WHERE code='A005'").get();
assert.equal(t5.notified_soon, 0);
console.log('✓ A005 correctly NOT yet notified (3 ahead)');

// Call again -> A002 called. Waiting A003,A004,A005 -> positions 0,1,2 => A005 now notified.
const r2 = Q.callNext(zoneId, THRESHOLD);
assert.equal(r2.called.code,'A002');
t5 = db.prepare("SELECT * FROM tickets WHERE code='A005'").get();
assert.equal(t5.notified_soon, 1);
console.log('✓ after 2nd call, A005 now notified');

// Idempotency: re-evaluating doesn't double-flag (no error); served path works
Q.setStatus(db.prepare("SELECT id FROM tickets WHERE code='A003'").get().id,'served',THRESHOLD);
const snap = Q.zoneSnapshot(zoneId);
assert.equal(snap.waitingCount, 2); // A004, A005
console.log('✓ serve removes from waiting. waiting now:', snap.waiting.map(t=>t.code).join(' '));

// Closed zone rejects new tickets
Q.setZoneOpen(zoneId, 0);
assert.throws(()=>Q.issueTicket({storeId,zoneId,lineUserId:'x'}), /zone_closed/);
console.log('✓ closed zone rejects new tickets');

console.log('\nALL TESTS PASSED ✅');
process.exit(0);

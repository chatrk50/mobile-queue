// Seed a demo store with zones. Safe to run once on a fresh DB.
import { db } from '../server/db.js';

const existing = db.prepare('SELECT COUNT(*) c FROM stores').get().c;
if (existing > 0) {
  console.log('Stores already exist — skipping seed. (Delete data/queue.db to reset.)');
  process.exit(0);
}

const store = db.prepare('INSERT INTO stores (name) VALUES (?)').run('Demo Shabu House');
const storeId = store.lastInsertRowid;

const zones = [
  { name: 'โซน A / Zone A', prefix: 'A' },
  { name: 'โซน B / Zone B', prefix: 'B' },
  { name: 'Buffet', prefix: 'C' },
];
const ins = db.prepare('INSERT INTO zones (store_id, name, prefix) VALUES (?,?,?)');
for (const z of zones) ins.run(storeId, z.name, z.prefix);

console.log(`Seeded store #${storeId} "Demo Shabu House" with ${zones.length} zones.`);
console.log('Zones:', db.prepare('SELECT id, name, prefix FROM zones WHERE store_id=?').all(storeId));

// Seed a demo store with zones. Safe to run once on a fresh DB.
import { db } from '../server/db.js';

const existing = db.prepare('SELECT COUNT(*) c FROM stores').get().c;
if (existing > 0) {
  console.log('Stores already exist — skipping seed. (Delete data/queue.db to reset.)');
  process.exit(0);
}

const store = db.prepare('INSERT INTO stores (name) VALUES (?)').run('SAT Market');
const storeId = store.lastInsertRowid;

const zones = [
  { name: 'Zone A', prefix: 'A' },
  { name: 'Zone B', prefix: 'B' },
];
const ins = db.prepare('INSERT INTO zones (store_id, name, prefix) VALUES (?,?,?)');
for (const z of zones) ins.run(storeId, z.name, z.prefix);

// Default Quick-Service menu (editable in the cashier)
const menu = [
  { name: 'Original Yogurt', price: 35 },
  { name: 'Mango Yogurt', price: 45 },
  { name: 'Strawberry Yogurt', price: 45 },
  { name: 'Mixed Berry Yogurt', price: 50 },
  { name: 'Extra Topping', price: 15 },
];
const minsert = db.prepare('INSERT INTO menu_items (name, price, sort) VALUES (?,?,?)');
menu.forEach((m, i) => minsert.run(m.name, m.price, i + 1));
console.log(`Seeded ${menu.length} menu items.`);

console.log(`Seeded store #${storeId} "SAT Market" with ${zones.length} zones.`);
console.log('Zones:', db.prepare('SELECT id, name, prefix FROM zones WHERE store_id=?').all(storeId));

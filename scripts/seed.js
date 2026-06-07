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

// YO-DEE Yogurt Smoothie menu (Thai name, English name, price) — editable in the cashier.
const drinks = [
  ['โยเกิร์ตปั่น Original', 'Yogurt Original', 40],
  ['โยเกิร์ตปั่นข้าวเหนียวนิล', 'Yogurt with Midnight Sticky Rice', 49],
  ['โยเกิร์ตปั่นข้าวโอ๊ต', 'Yogurt with Oats', 49],
  ['โยเกิร์ตปั่นมะม่วง', 'Yogurt with Mango', 49],
  ['โยเกิร์ตปั่นสตรอวเบอร์รี่', 'Yogurt with Strawberry', 49],
  ['โยเกิร์ตปั่นบัวลอย', 'Yogurt with Rice Balls', 49],
  ['โยเกิร์ตปั่นบุกน้ำผึ้ง', 'Yogurt with Honey Konjac', 49],
  ['โยเกิร์ตปั่นโอริโอ้', 'Yogurt with Oreo', 49],
  ['โยเกิร์ตปั่นคิทแคท', 'Yogurt with KitKat', 49],
  ['โยเกิร์ตปั่นอโวคาโด', 'Yogurt with Avocado', 59],
  ['โยเกิร์ตปั่นน้ำผึ้ง', 'Yogurt with Honey', 49],
  ['โยเกิร์ตปั่นเฉาก๊วย', 'Yogurt with Grass Jelly', 49],
  ['โยเกิร์ตปั่นปีโป้', 'Yogurt with Pipo Jelly', 49],
  ['โยเกิร์ตปั่นกล้วย', 'Yogurt with Banana', 49],
  ['โยเกิร์ตปั่นอโวคาโดสาหร่ายสไปรูลิน่า', 'Yogurt with Avocado Blue Spirulina', 65],
  ['โยเกิร์ตปั่นข้าวเหนียวมะม่วง', 'Yogurt with Mango & Midnight Sticky Rice', 59],
];
const toppings = [
  ['ปีโป้', 'Pipo Jelly'], ['คิทแคท', 'KitKat'], ['โอริโอ้', 'Oreo'], ['เฉาก๊วย', 'Grass Jelly'],
  ['บุกน้ำผึ้ง', 'Honey Konjac'], ['บัวลอย', 'Rice Balls'], ['ข้าวเหนียวนิล', 'Midnight Sticky Rice'], ['ข้าวโอ๊ต', 'Oats'],
];
const minsert = db.prepare('INSERT INTO menu_items (name, name_en, price, image, category, sort) VALUES (?,?,?,?,?,?)');
let s = 0;
// No image by default -> the menu shows a flavor emoji. The cashier can upload a real
// photo per item (Menu -> 📷), stored as a data URL; that survives until the next reseed.
for (const [name, en, price] of drinks) minsert.run(name, en, price, null, 'drink', ++s);
for (const [name, en] of toppings) minsert.run(name, en, 10, null, 'topping', ++s);
console.log(`Seeded ${drinks.length} drinks + ${toppings.length} toppings.`);

console.log(`Seeded store #${storeId} "SAT Market" with ${zones.length} zones.`);
console.log('Zones:', db.prepare('SELECT id, name, prefix FROM zones WHERE store_id=?').all(storeId));

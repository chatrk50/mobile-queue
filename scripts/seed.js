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
// Each drink points at public/assets/menu/N.png (N = menu number, 1..16). Drop those
// files in and they appear permanently; until a file exists the UI shows a flavor emoji
// (the <img onerror> fallback). The cashier 📷 button can also upload a photo per item,
// but that's stored in the DB and is wiped on the next reseed — committed files persist.
// Exact (case-sensitive) committed filenames in public/assets/menu/, in `drinks` order.
const drinkImages = [
  '1-Original.png', '2-Midnight-Sticky-Rice.png', '3-Oats.png', '4-Mango.png',
  '5-Stawberry.png', '6-Rice-Balls.png', '7-Honey-Konjac.png', '8-Oreo.png',
  '9-Kitkat.png', '10-Avocado.png', '11-Honey.png', '12-Grass-Jelly.png',
  '13-Pipo-Jelly.png', '14-Banana.png', '15-Avocado-Blue-Spirulina.png',
  '16-Mango-and-Midnight-Sticky-rice.png',
];
drinks.forEach(([name, en, price], i) => minsert.run(name, en, price, `/assets/menu/${drinkImages[i]}`, 'drink', ++s));
for (const [name, en] of toppings) minsert.run(name, en, 10, null, 'topping', ++s);
console.log(`Seeded ${drinks.length} drinks + ${toppings.length} toppings.`);

console.log(`Seeded store #${storeId} "SAT Market" with ${zones.length} zones.`);
console.log('Zones:', db.prepare('SELECT id, name, prefix FROM zones WHERE store_id=?').all(storeId));

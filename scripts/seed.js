// Seed a demo store + zones + the YO-DEE menu. Safe to run repeatedly — it no-ops when a
// store already exists. Importable as seedDemo() (used by the app to auto-populate an
// ephemeral UAT sandbox on boot) and runnable directly as `npm run seed`.
import { db } from '../server/db.js';

export function seedDemo() {
  const existing = db.prepare('SELECT COUNT(*) c FROM stores').get().c;
  if (existing > 0) return { seeded: false, reason: 'stores_exist' };

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
  // Each drink points at public/assets/menu/<file>. Until a file exists the UI shows a flavor
  // emoji (the <img onerror> fallback). Committed files persist across reseeds.
  const drinkImages = [
    '1-Original.png', '2-Midnight-Sticky-Rice.png', '3-Oats.png', '4-Mango.png',
    '5-Stawberry.png', '6-Rice-Balls.png', '7-Honey-Konjac.png', '8-Oreo.png',
    '9-Kitkat.png', '10-Avocado.png', '11-Honey.png', '12-Grass-Jelly.png',
    '13-Pipo-Jelly.png', '14-Banana.png', '15-Avocado-Blue-Spirulina.png',
    '16-Mango-and-Midnight-Sticky-rice.png',
  ];
  drinks.forEach(([name, en, price], i) => minsert.run(name, en, price, `/assets/menu/${drinkImages[i]}`, 'drink', ++s));
  for (const [name, en] of toppings) minsert.run(name, en, 10, null, 'topping', ++s);
  return { seeded: true, storeId, zones: zones.length, drinks: drinks.length, toppings: toppings.length };
}

// White-label onboarding: a BLANK store + one zone so a brand-new instance boots usable,
// WITHOUT any YO-DEE menu / ingredients. The owner adds their own menu + branches in the
// cashier UI. No-ops once a store exists. Store name comes from BRAND_NAME/BRAND_SHORT.
export function seedBlank() {
  const existing = db.prepare('SELECT COUNT(*) c FROM stores').get().c;
  if (existing > 0) return { seeded: false, reason: 'stores_exist' };
  const name = process.env.BRAND_NAME || process.env.BRAND_SHORT || 'ร้านของฉัน';
  const store = db.prepare('INSERT INTO stores (name) VALUES (?)').run(name);
  const storeId = store.lastInsertRowid;
  db.prepare('INSERT INTO zones (store_id, name, prefix) VALUES (?,?,?)').run(storeId, 'Zone A', 'A');
  return { seeded: true, storeId, store: name, zones: 1, drinks: 0 };
}

// Run directly via `npm run seed` (demo) or `npm run seed -- blank` for a clean brand.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/seed.js')) {
  const blank = process.argv.includes('blank') || (process.env.SEED || '').toLowerCase() === 'blank';
  if (blank) {
    const r = seedBlank();
    if (!r.seeded) console.log('Stores already exist — skipping blank seed.');
    else console.log(`Seeded BLANK store #${r.storeId} "${r.store}" with 1 zone, no menu (add yours in the cashier).`);
  } else {
    const r = seedDemo();
    if (!r.seeded) console.log('Stores already exist — skipping seed. (Delete data/queue.db to reset.)');
    else console.log(`Seeded store #${r.storeId} "SAT Market" with ${r.zones} zones, ${r.drinks} drinks + ${r.toppings} toppings.`);
  }
  process.exit(0);
}

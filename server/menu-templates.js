// Starter-menu templates by vertical. A brand-new owner can one-tap pre-fill a sample menu
// instead of typing items from scratch — turning the empty-shop activation gap into a populated,
// sellable menu instantly. Items are plain {name, price, category}; the owner edits/deletes freely
// afterwards. Prices are illustrative THB. category ∈ 'drink' | 'topping'.
export const MENU_TEMPLATES = {
  yogurt: {
    label: 'โยเกิร์ต / สมูทตี้', emoji: '🍦',
    items: [
      { name: 'โยเกิร์ตปั่น', price: 45 },
      { name: 'โยเกิร์ตผลไม้รวม', price: 50 },
      { name: 'นมเปรี้ยวโซดา', price: 40 },
      { name: 'กรีกโยเกิร์ต', price: 55 },
      { name: 'สมูทตี้เบอร์รี่', price: 50 },
      { name: 'กราโนล่า', price: 10, category: 'topping' },
      { name: 'ผลไม้สด', price: 15, category: 'topping' },
      { name: 'น้ำผึ้ง', price: 5, category: 'topping' },
    ],
  },
  coffee: {
    label: 'กาแฟ', emoji: '☕',
    items: [
      { name: 'อเมริกาโน่', price: 45 },
      { name: 'ลาเต้', price: 55 },
      { name: 'คาปูชิโน่', price: 55 },
      { name: 'มอคค่า', price: 60 },
      { name: 'เอสเพรสโซ่', price: 40 },
      { name: 'โกโก้', price: 50 },
      { name: 'ช็อตเพิ่ม (espresso)', price: 15, category: 'topping' },
      { name: 'วิปครีม', price: 10, category: 'topping' },
    ],
  },
  tea: {
    label: 'ชา / ชานม', emoji: '🧋',
    items: [
      { name: 'ชานมไข่มุก', price: 50 },
      { name: 'ชาเขียวนม', price: 50 },
      { name: 'ชาไทย', price: 45 },
      { name: 'ชามะนาว', price: 40 },
      { name: 'โกโก้ปั่น', price: 55 },
      { name: 'ไข่มุก', price: 10, category: 'topping' },
      { name: 'พุดดิ้ง', price: 15, category: 'topping' },
      { name: 'วิปครีม', price: 10, category: 'topping' },
    ],
  },
  food: {
    label: 'อาหารตามสั่ง', emoji: '🍚',
    items: [
      { name: 'ข้าวกะเพราหมู', price: 50 },
      { name: 'ข้าวผัดหมู', price: 50 },
      { name: 'ข้าวไข่เจียว', price: 40 },
      { name: 'ผัดซีอิ๊ว', price: 55 },
      { name: 'ข้าวมันไก่', price: 50 },
      { name: 'ไข่ดาว', price: 10, category: 'topping' },
      { name: 'พิเศษ (เพิ่มข้าว/กับ)', price: 15, category: 'topping' },
    ],
  },
  bakery: {
    label: 'เบเกอรี่ / ขนม', emoji: '🥐',
    items: [
      { name: 'ครัวซองต์', price: 45 },
      { name: 'เค้กช็อกโกแลต', price: 55 },
      { name: 'คุกกี้', price: 25 },
      { name: 'ขนมปังสังขยา', price: 35 },
      { name: 'บราวนี่', price: 40 },
    ],
  },
};

/** Light list for the picker UI: id, label, emoji, item count. */
export function listTemplates() {
  return Object.entries(MENU_TEMPLATES).map(([id, t]) => ({ id, label: t.label, emoji: t.emoji, count: t.items.length }));
}

/** The normalised items of one template (category defaults to 'drink'), or null if unknown. */
export function templateItems(id) {
  const t = MENU_TEMPLATES[String(id || '')];
  if (!t) return null;
  return t.items.map((it) => ({ name: it.name, price: it.price, category: it.category === 'topping' ? 'topping' : 'drink' }));
}

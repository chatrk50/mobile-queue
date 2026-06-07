# Menu photos

Drop one square-ish photo per drink here, named by its **menu number** (the blue
circle on the board). The cashier + customer menus use them automatically; until a
file exists, that drink shows a flavor emoji instead (safe fallback).

| File | Drink |
|---|---|
| `1.png`  | โยเกิร์ตปั่น Original — Yogurt Original |
| `2.png`  | โยเกิร์ตปั่นข้าวเหนียวนิล — Midnight Sticky Rice |
| `3.png`  | โยเกิร์ตปั่นข้าวโอ๊ต — Oats |
| `4.png`  | โยเกิร์ตปั่นมะม่วง — Mango |
| `5.png`  | โยเกิร์ตปั่นสตรอวเบอร์รี่ — Strawberry |
| `6.png`  | โยเกิร์ตปั่นบัวลอย — Rice Balls |
| `7.png`  | โยเกิร์ตปั่นบุกน้ำผึ้ง — Honey Konjac |
| `8.png`  | โยเกิร์ตปั่นโอริโอ้ — Oreo |
| `9.png`  | โยเกิร์ตปั่นคิทแคท — KitKat |
| `10.png` | โยเกิร์ตปั่นอโวคาโด — Avocado |
| `11.png` | โยเกิร์ตปั่นน้ำผึ้ง — Honey |
| `12.png` | โยเกิร์ตปั่นเฉาก๊วย — Grass Jelly |
| `13.png` | โยเกิร์ตปั่นปีโป้ — Pipo Jelly |
| `14.png` | โยเกิร์ตปั่นกล้วย — Banana |
| `15.png` | โยเกิร์ตปั่นอโวคาโดสาหร่ายสไปรูลิน่า — Avocado Blue Spirulina |
| `16.png` | โยเกิร์ตปั่นข้าวเหนียวมะม่วง — Mango & Sticky Rice |

Notes:
- Use **`.png`** with these exact names. Square crops (~300×300) look best (the button
  image is square, `object-fit: cover`).
- Files committed here are **permanent**. The cashier 📷 upload is handy for quick changes
  but is wiped on the next redeploy (the DB reseeds), so prefer committing files here.

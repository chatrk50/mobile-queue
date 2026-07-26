# System Audit — ตรวจโครงสร้างทั้งระบบ (2026-07-26)

> **สถานะ: แผน 6 ขั้นในหัวข้อ §5 ทำครบแล้วทั้งหมด (2026-07-26)** — commit ละขั้น บน staging
> §1 และ §2 ที่ปิดแล้วมีเครื่องหมาย ✔ กำกับ · ที่ยังเหลือคือ §2 "ข้อมูลซ้ำสองที่" กับ branch scoping
> ซึ่งตั้งใจยกไปรอบหน้าเพราะกระทบวิธีคิดตัวเลขย้อนหลัง ต้องให้เจ้าของตัดสินก่อน

ตรวจ 3 มุมแบบขนาน (API/สิทธิ์ · ฐานข้อมูล · หน้าจอทั้งสอง bundle) แล้ว**ยืนยันข้อวิกฤตด้วยการอ่านโค้ดจริงก่อนบันทึก**ทุกข้อที่ติดธง ✅ verified
บรรทัดอ้างอิงตรงกับ commit บน `staging` ณ วันตรวจ — บรรทัดจะเลื่อนเมื่อโค้ดเปลี่ยน ใช้ชื่อฟังก์ชันเป็นหลัก

---

## 0) แก้ไปแล้วในรอบนี้ (commit "Coupon hub …")

| เรื่อง | ที่มา |
|---|---|
| `/api/staff/me` เป็นช่องเดา PIN แบบไม่จำกัดครั้ง (pinValueOK ไม่นับพลาด) → เปลี่ยนเป็น `pinOK` | ✅ verified, index.js |
| รายงานละเอียดนับท็อปปิ้งด้วย `kind='topping'` ซึ่งไม่มีจริง (มีแต่ base/addon) → ท็อปปิ้งเป็น 0 เสมอ | ✅ verified, queue.js `detailedReports` |
| ดึงลูกค้ากลับ: ส่ง LINE พลาดแต่คูปองออกไปแล้ว → ออกเฉพาะเมื่อส่งสำเร็จ (LINE stub = โหมดทดสอบ ยังออกให้) | ✅ verified, `sendCampaign` |
| มูลค่าของแถมฝังตายในโค้ด 5 จุด (วันเกิด ฿100, สะสม ฿49×3, ดึงกลับ ฿49) → รวมเป็น coupon templates แก้ได้จากหน้า "คูปอง & แคมเปญ" | ✅ verified |
| ยกเลิกคูปองที่แจกผิดไม่ได้ + ไม่รู้ภาระคงค้าง → แท็บ "คูปองคงค้าง" + ปุ่มยกเลิก (log ลง sale_events) | ✅ verified |

---

## 1) 🔴 วิกฤต — ควรแก้เป็นรอบถัดไป (เรียงตามความเสี่ยง)

### 1.1 ลูกค้าตั้งราคาเองได้ (เศรษฐกิจ ไม่ใช่ injection) — ✅ verified
`createOrder` (queue.js, `price: Math.max(0, Number(it.price) || 0)`) รับราคาจาก client ตรงๆ ไม่เทียบกับ `menu_items` เลย และ `POST /api/zones/:zoneId/order` เป็น public
→ ลูกค้าเปิด DevTools สั่งแก้วละ ฿0 ได้ ยอดขาย/P&L/แต้มสะสมตามตัวเลขปลอมทั้งหมด
**แนวแก้:** ฝั่ง server ต้อง resolve ราคาเองจากเมนู (base + topping + ตัวคูณ channel) เฉพาะ `source='customer'`; POS แคชเชียร์ค่อยตามทีหลัง งานนี้ต้องออกแบบดีๆ เพราะราคาจริงประกอบจากหลายส่วน — **อย่า patch ลวก**

### 1.2 ข้อมูลลูกค้ารั่วผ่านเบอร์โทร (PDPA) — ✅ verified แนวคิด (agent ตรวจ, ผมยืนยัน route ไม่มี gate)
- `GET /api/customers/:key/orders` และ `GET /api/loyalty/:key` เป็น public และรับ key แบบ `tel:08xxxxxxxx` → เดาเบอร์ = เห็นประวัติสั่งซื้อ/แต้ม/วันเกิดของคนอื่น
- `POST /api/loyalty/:key/birthday` และ `/refer` เขียนข้อมูลของ key ใครก็ได้ (ตั้งวันเกิดปลอม → ได้คูปองวันเกิดอัตโนมัติ)
**แนวแก้:** key ที่ขึ้นต้น `tel:` ต้องมี PIN (พนักงาน) เท่านั้น; key แบบ `U…` ให้พิสูจน์ตัวตนแบบเดียวกับ `/api/consent` (regex + ตรงกับ body)

### 1.3 Brute force / DoS จุด login พนักงาน
`POST /api/staff/login` ไม่นับพลาด (ตั้งใจ — UI จะ fallback ไป `/api/auth` ที่นับอยู่แล้ว แต่คนยิง API ตรงไม่ผ่าน UI) และทุกครั้งที่เดา ระบบรัน scrypt กับ**ทุกแถว staff** แบบ synchronous → ยิงพร้อมกันไม่กี่สายก็ค้างทั้ง event loop
**แนวแก้:** นับพลาดใน login ตรงจุดที่ *ไม่ใช่* fallback path (เช่น นับเมื่อ header บอกว่าไม่ใช่ UI) หรือย้ายไปนับที่ IP เสมอแล้วเลิกนับซ้ำใน `/api/auth`; และหา staff จาก identifier ก่อนค่อย verify แถวเดียว

### 1.4 แจกคูปองผ่านลิงก์โดนดูดโควตาได้
`POST /api/claim/:token` เช็คแค่ regex `U…` ซึ่งปลอมได้ → สคริปต์สร้าง id ปลอมดูด `issue_limit` จนหมด (คูปองจริงถึงมือลูกค้าปลอม)
**แนวแก้:** ตรวจ LIFF access token กับ LINE `/v2/profile` ก่อนรับ claim (จุดเดียวกันนี้ใช้กับ `/like` และ `/consent` ได้ด้วย)

### 1.5 ไม่มี global error handler
ไม่มี `app.use((err,req,res,next)=>…)` → route ที่ throw นอก try/catch (มี ~60 จุด รวม public หลายจุด) ตอบ 500 พร้อม **stack trace** เมื่อ `NODE_ENV` ไม่ใช่ production
**แนวแก้:** เพิ่ม error middleware ตัวเดียวปิดท้าย + ตั้ง `NODE_ENV=production` บน Render ให้แน่ใจ

### 1.6 งานเขียนหลายจังหวะไม่อยู่ใน transaction (เงินหาย/แต้มหายเมื่อพลาดกลางทาง)
จุดที่เสี่ยงจริง (agent พบ, จุดสำคัญผมอ่านยืนยันแล้ว):
- `redeemCustomerCoupon`: เผาคูปองแล้วค่อยตั้งส่วนลดแยกกัน → พลาดกลาง = คูปองหาย ส่วนลดไม่เข้า
- `redeemRewardOnOrder`: หักแต้มใน tx แต่ส่วนลดอยู่นอก tx
- `cancelOrderTicket`: void order + คืนสต๊อก + คืนแต้ม + ปิด ticket = 4 คำสั่งแยก
- `applyCouponToOrder`, `claimLucky`, `payPartial`/`payItems`, `receivePurchaseOrder` (รับ PO ซ้ำได้ถ้าล่มกลางลูป)
**แนวแก้:** ห่อคู่ "เผาสิทธิ์+ให้ส่วนลด" ใน `db.transaction()` เสมอ — และระวัง: shim `db.transaction` ปัจจุบัน**ซ้อนกันไม่ได้** (BEGIN ซ้ำจะพัง) ต้องทำ savepoint ก่อนถ้าจะห่อฟังก์ชันที่เรียกกันเอง

### 1.7 Index ที่ขาด (ช้าลงเรื่อยๆ ตามอายุร้าน)
ตารางโตไม่หยุดแต่ query หลักไม่มี index รองรับ:
```sql
CREATE INDEX IF NOT EXISTS idx_order_items_order  ON order_items(order_id);          -- ทุก orderForTicket/สต๊อก
CREATE INDEX IF NOT EXISTS idx_loyalty_moves_order ON loyalty_moves(order_id);        -- กัน earn ซ้ำ ทุกการจ่าย
CREATE INDEX IF NOT EXISTS idx_tickets_line_user   ON tickets(line_user_id);          -- ทุก query โปรไฟล์/CRM
CREATE INDEX IF NOT EXISTS idx_customer_coupons_order ON customer_coupons(used_order_id);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_at      ON coupon_uses(at);
```
และตัวหนักสุด: subquery "ขายไปกี่แก้ว" ใน `listMenu` join order_items ทั้งตารางทุกครั้งที่ลูกค้าเปิดเมนู — ควร bound ช่วงเวลาหรือทำ rollup

### 1.8 Guard สถานะ order หละหลวม — ✅ verified บางส่วน
- `cancelOrderTicket` void ด้วย `WHERE ticket_id=?` (โดนทุก order ของ ticket) และไม่มี `AND payment_status!='void'` → กดยกเลิกซ้ำ = log ยอดซ้ำ
- `setOrderPaid` / `attachSlip` / `claimOrderPaid` ไม่กัน `void` ใน UPDATE → order ที่ถูก void แล้วฟื้นเป็น paid/claimed ได้เมื่อ race กัน
**แนวแก้:** เติม `AND payment_status NOT IN ('paid','void')` + เช็ค `changes===0` ทุกจุดเปลี่ยนสถานะ

### 1.9 คำสั่งกวาดไม่ scope (ระเบิดเวลาสาย SaaS หลาย tenant)
- `clearTransactions`: `DELETE FROM <table>` 14 ตาราง **ไม่มี WHERE** — บน branch saas จะล้างของทุก tenant
- reset เที่ยงคืน + clear: `UPDATE zones SET last_number=0` ไม่มี WHERE
บน prod ร้านเดียวยังไม่ระเบิด แต่ต้องแก้ก่อน merge เข้าสาย saas ทุกกรณี

---

## 2) 🟡 ควรทำ (จัดเป็นหมวด)

**ข้อมูลซ้ำสองที่แล้วเพี้ยนได้ (denormalization)**
- `customers.points` กับ ledger `loyalty_moves` แยกกันเดิน และตอน void มี `MAX(0, points-?)` clamp → เพี้ยนแล้วไม่มีวันตรงกันอีก ควรให้ ledger เป็นความจริงเดียว
- void order **ไม่คืน** `coupons.used_count`/`coupon_uses` → โควตาคูปองรหัสหดถาวร
- `order_items.name` เป็น join key กลับไป `menu_items.name` → **เปลี่ยนชื่อเมนู = ประวัติ/สูตร/สต๊อกหลุดทั้งแถบ** (ควรเก็บ `menu_item_id` เพิ่มแบบ additive) — ตรงกับที่เคยเจอบน LD ว่า rename ทำ favourites หาย
- เวลาเปิดร้านมี 2 ชุด (settings `hours:*` กับ `stores.hours_*`) คนละ caller อ่านคนละชุด
- `orders.paid_amount` ไม่ถูกตั้งใน `setOrderPaid` → บิลจ่ายเต็มแสดง 0

**เวลา/timezone**
- `purchasePlan` ใช้ UTC 14 วัน (ที่อื่นใช้ Bangkok) · `saveTenderRecon` เก็บเวลา +7 ปนกับ UTC · segment ลูกค้า (`at_risk/lost`) คิดจาก ms ไม่ใช่วันปฏิทินไทย → ลูกค้าสลับกลุ่มเร็ว/ช้าได้ 7 ชม.
- ควรมี helper `bkkToday()` เดียวแทน 3 สำนวนที่ใช้อยู่

**โตไม่หยุด / retention**
- `slips.image` (base64 เต็มใบ ไม่จำกัดขนาดจริงจัง ไม่เคยลบ) · `push_log` · `sale_events` · promo image 1.5MB ใน settings — ควรมี retention job (เช่น 90 วัน) และย้ายรูปออกจาก DB
- prepared-statement cache โตตามจำนวน "วัน" เพราะ interpolate วันที่ลง SQL (`dailyReport`, `archiveTodaySales`, `laborActual`) — bind เป็นพารามิเตอร์แทน

**สิทธิ์ระดับ manager ที่อาจควรเป็น owner** (ตัดสินใจเชิงนโยบาย ไม่ใช่บั๊ก)
- export ลูกค้าทั้งร้าน (`/api/crm/customers.xlsx`) + ยิง campaign · `POST /api/finance` (ตัวเลขที่ปั้น P&L) · ลบรายการเงินสด (`cash/move/:id/delete`) · `report.xlsx` (เทียบ backup ที่เป็น ownerOK)

**Abuse surface (public endpoints)**
- สร้าง ticket/order ไม่จำกัดต่อ IP → ปั่นเลขคิวได้ · SSE stream เปิดได้ไม่จำกัด · QR renderer ไม่มี cache · `express.json 2mb` ครอบทุก route (ควรเล็กลง global แล้วขยายเฉพาะ route รูป)
- `GET /api/coupons?customer=` เป็น public แต่ **mutate** (convertReadyRewards) → ควรแยก read/convert

---

## 3) 🟢 by design — บันทึกไว้กันเข้าใจผิดภายหลัง

- `staff/login` ไม่นับ PIN พลาด: ตั้งใจ เพราะ UI fallback ไป `/api/auth` ที่นับแล้ว (นับสองที่ = ล็อกเครื่องจริงใน ~4 ครั้ง) — ช่องโหว่คือ direct API เท่านั้น (ดู 1.3)
- `zoneSnapshot`/`stream` เช็ค pin แบบเงียบ (`pinValueOK`): ตั้งใจ ใช้แค่ตัดสินใจ "โชว์ชื่อลูกค้าไหม" บนบอร์ดที่ poll ตลอด — ถ้านับพลาดจะล็อกบอร์ดหน้าร้านเอง
- migration แบบ additive + guarded ALTER: เป็นกติกาของ repo นี้
- `laborActual` / `archiveTodaySales` / `report.xlsx` / `listReductions` ยังไม่ branch-scoped: หนี้เดิมที่บันทึกไว้แล้ว + agent พบเพิ่มว่า `req.staff.branchIds` ถูกเก็บตอน login แต่**ไม่เคยถูกใช้ enforce ที่ไหนเลย** (`cashBranch` รับ branchId จาก query ตรงๆ) — รวมแก้เป็นงานเดียว "branch scoping"

---

## 4) หน้าจอ (frontend bundles) — cashier 541KB / LIFF 206KB

**แก้ไปแล้วในรอบนี้ (commit "Frontend audit round"):**
- ✅ verified **บั๊กจริง:** id `moreMenu` ซ้ำ 2 ที่ (dropdown มือถือบนแถบหัว จากรอบ header-lean ทับ id ของ modal "เพิ่มเติม" ต่อออเดอร์) → `openMoreMenu()` เปิดผิดตัว ปุ่มเพิ่มเติมบนการ์ดออเดอร์ใช้ไม่ได้บนทุกจอ — เปลี่ยน modal เป็น `orderMoreMenu`
- ✅ เพิ่ม gzip (`compression`) — bundle ~541KB → ~139KB (−74%) ตรงโจทย์ cellular; ยกเว้น SSE stream (gzip buffer จะทำ live update ค้าง)

**ควรทำต่อ (เรียงตามผลตอบแทน):**
1. `vendor/jsQR.min.js` (251KB) + `Sortable.min.js` (44KB) โหลดทุกครั้งที่เปิดแคชเชียร์ แต่ใช้เฉพาะตอนสแกนสลิป/ลากเรียงเมนู → โหลดตอนกดใช้ (dynamic import)
2. `card-reward.png` **834KB** โชว์บนมือถือลูกค้า → แปลง WebP ย่อขนาด (ประหยัด ~95%) — เป็นงานอาร์ตแบรนด์ ให้เจ้าของยืนยันคุณภาพก่อน
3. ✅ verified ไฟล์อาร์ตการ์ดสมาชิก `card-bloom/pure/essence.png` + `S__46915610.jpg` รวม **2.4MB ไม่ถูกอ้างในโค้ดเลย** — เป็นงานการ์ด AI ที่เคยสั่งทำ ([[card-design-style-feedback]]) **ไม่ลบเอง** รอเจ้าของตัดสิน (อยู่ใน git history เสมอ)
4. Polling ไม่หยุดเมื่อจอถูกพับ: LIFF poll ตั๋วทุก 3 วิแม้ลูกค้าสลับไปแอปธนาคาร (~300 requests/15 นาที), แคชเชียร์ poll ทุกโซนทุก 5 วิควบคู่ SSE ที่ส่งของเดียวกัน → เติม `visibilitychange` gate + เทียบ snapshot ก่อน render
5. `renderZone` เขียน innerHTML ใหม่ทุก 5 วิแม้ข้อมูลไม่เปลี่ยน (ทับ :active ระหว่างนิ้วแตะ) → เทียบ signature ก่อน (LIFF `renderTimeline` มี pattern นี้แล้ว)
6. Cache header ยังไม่ครอบ `.js/.css` (jsQR 251KB revalidate ทุกโหลด) → ต้องทำ `?v=` cache-busting ก่อนถึงเปิด max-age ได้
7. `@import` ฟอนต์ 2 ชั้นใน styles.css block first paint → preconnect หรือ self-host woff2
8. Touch target ต่ำกว่า 44px หลายจุดที่ใช้บ่อยจริง: ปุ่ม −/+ ตะกร้า LIFF (24px), billDec/billInc แคชเชียร์ (28px), `.kmark` ครัว (36px), ปุ่ม ✕ modal ~9 จุดไม่มี aria-label
9. Contrast ไม่ผ่าน AA: `.pill.open` (3.9:1) และ `.pill.soon` (4.2:1) — เป็น pill สถานะ "ชำระแล้ว/ค้างชำระ" ที่แคชเชียร์ต้องอ่านเร็วที่สุด → เข้มขึ้นเป็น #0f6b57 / #7a5c00
10. Dead code เล็กๆ (ฟังก์ชัน/CSS ~10 จุด: `moveMenu`, `toggleSuppliers`, `openWinback`, block `#counterInfo` ที่อ้าง 4060.png 381KB ฯลฯ) — เก็บกวาดรอบเดียว
11. Inline `style=` ซ้ำ ~90KB ใน cashier → ยก 15 pattern ที่ซ้ำสุดเป็น class ใน styles.css

---

## 5) ลำดับที่แนะนำ — ✅ ทำครบแล้ว 6/6 (2026-07-26)

| # | เรื่อง | สถานะ | พิสูจน์อย่างไร |
|---|---|---|---|
| 1 | ราคา order ฝั่ง server (1.1) | ✅ | ยิง HTTP จริง: ส่ง ฿1 กับเครื่องดื่ม ฿40 → คิด ฿40 · เมนูปลอม → 409 · e2e 4 ข้อ |
| 2 | Transaction + guard สถานะ (1.6, 1.8) | ✅ | shim รองรับ SAVEPOINT แล้ว (เดิมซ้อนไม่ได้) · e2e 10 ข้อ รวม void→pay, ยกเลิกซ้ำ |
| 3 | Index (1.7) | ✅ | EXPLAIN QUERY PLAN เปลี่ยนจาก SCAN → SEARCH USING INDEX |
| 4 | ปิดรู PII เบอร์โทร (1.2) + error middleware (1.5) | ✅ | ยิง HTTP จริง: 4 route ที่ใช้ `tel:` → 403 · LINE id ยัง 200 |
| 5 | Retention (§2 "โตไม่หยุด") | ✅ | e2e 6 ข้อ รวมกรณีสลิปของบิลที่ยังไม่ปิด = ห้ามลบ |
| 6 | Frontend: polling / payload / a11y (§4) | ✅ | วัดในเบราว์เซอร์: poll 2 ครั้ง/7วิ ตอนเปิด → **0 ครั้ง/8วิ ตอนพับจอ** → กลับมาแล้วรีเฟรชใน 700ms · contrast 5.65/5.60/5.32 |

**ยังไม่ได้ทำ (ตั้งใจ) — ต้องให้เจ้าของตัดสินก่อน**
- **ข้อมูลซ้ำสองที่** (§2): `customers.points` vs ledger, `coupons.used_count` ไม่คืนตอน void, `order_items.name` เป็น join key (เปลี่ยนชื่อเมนู = ประวัติหลุด) — แก้แล้วกระทบ**ตัวเลขย้อนหลัง** ต้องตกลงก่อนว่าจะยึดอันไหนเป็นความจริง
- **Branch scoping + scope คำสั่งกวาด** (1.9): จำเป็น**ก่อน** merge เข้าสาย saas เท่านั้น ร้านเดียวยังไม่กระทบ
- **LIFF token verification** (1.4) และ rate limiting (1.3): ต้องต่อ LINE API จริง ทำตอนมี LINE credential พร้อม
- ภาพ `card-reward.png` 834KB + ไฟล์อาร์ต 2.4MB ที่ไม่ถูกใช้: รอเจ้าของยืนยันคุณภาพ/จะเก็บไหม

# YO-DEE — รายงานตรวจสอบระบบเต็มรูปแบบ (6 บทบาท) — 2026-08-10

ตรวจโดยทีม 6 ชุด สวมบทบาทจริง แต่ละชุดรัน instance แยก + ทดสอบสด + พิสูจน์ด้วย SQL/HTTP
(บัญชี, แคชเชียร์, ความปลอดภัย, ลูกค้า, เจ้าของร้าน, ระบบ/เน็ตเวิร์ก/อนาคต).
ทุกข้อ CRITICAL ยืนยันซ้ำกับโค้ดจริงด้วยตนเองแล้ว.

## ภาพรวม
- **เอนจินหลักแข็งแรง**: ราคาเสิร์ฟฝั่งเซิร์ฟเวอร์กันแฮก, กันกดซ้ำ (สร้าง/จ่ายเต็ม/แลกแต้ม), แข่งกันกดพร้อมกันปลอดภัย, escaping กัน XSS, webhook ตรวจ signature, durability (Turso replica + sync หลายจุด + backup รายวัน), รายงานยอดขาย/เงินสดตรงทุกสตางค์, ปุ่ม UI ไม่มีตัวตาย, ทุกหน้าตั้งค่ามี back+close.
- **จุดอ่อนหนักอยู่ 4 กลุ่ม**: (1) ความปลอดภัย config บน prod, (2) เงินรั่วฝั่งแคชเชียร์, (3) ทางตัน/จอค้างฝั่งลูกค้า, (4) ต้นทุน-กำไร-ภาษีเชื่อไม่ได้.

---

## อันดับความรุนแรงข้ามทุกมิติ

### 🔴 CRITICAL — แก้ก่อน

| รหัส | มิติ | ปัญหา | หลักฐาน |
|---|---|---|---|
| SEC-C1 | ความปลอดภัย | `trust proxy: true` → ปลอม X-Forwarded-For เดา PIN ไม่จำกัดครั้งจากอินเทอร์เน็ต (lockout ใช้ไม่ได้) | index.js:21,138 · ยิง 30 ครั้ง IP ปลอม = 0 lockout |
| SEC-C2 | ความปลอดภัย | PIN เจ้าของปริยาย `1234` ถ้าไม่ตั้ง env → ดัมพ์ DB ได้ | index.js:37 · `/api/admin/backup.json?pin=1234` = ทั้งก้อน |
| SEC-C3 | ความปลอดภัย | SESSION_SECRET ตกไปใช้ค่า PIN → จับ cookie 1 อันถอดกุญแจ offline 10ms ปลอมสิทธิ์เจ้าของ 10 ปี | auth.js:32-34 |
| CUS-C1 | ลูกค้า | ลูกค้าถูกพักสิทธิ์กดสั่ง → จอขาวว่างเปล่า ตะกร้าหาย ต้องปิดแอป | liff/index.html:1596 (toast อย่างเดียว ไม่คืนจอ) |
| CUS-C2 | ลูกค้า | เมนู "หมด" ยังสั่ง+จ่ายได้ผ่านสั่งซ้ำ/ตะกร้าเก่า | queue.js:3987 catalogPrice ไม่เช็ค soldout |
| CASH-1 | แคชเชียร์ | จ่ายแยก 2 ช่องทาง: เงินสดหายจากระบบ (เก็บ method เดียว/บิล) | queue.js:1130,4287,4718 |
| CASH-2 | แคชเชียร์ | ลดราคาหลังรับเงินแล้ว = รายได้+เงินคาดหวังหายเงียบ (กันแค่ void ไม่กัน paid) | queue.js:4373-4376 |
| ACC-F1 | บัญชี | ต้นทุน/กำไรของวันที่ปิดแล้วเปลี่ยนย้อนหลังทุกครั้งที่ซื้อของเข้า (คิดที่ avg_cost ปัจจุบัน) | queue.js:2017 · +฿128.65 พิสูจน์แล้ว |
| ACC-F2 | บัญชี | ค่าบรรจุภัณฑ์คิดซ้ำ 2 รอบ (อยู่ใน BOM แล้ว + บวกทับ) | queue.js:849-852 |

### 🟠 HIGH

| รหัส | มิติ | ปัญหา |
|---|---|---|
| CUS-C3/C4 | ลูกค้า | โซนผิด→error อังกฤษเต็มจอ · เมนูโหลดพลาด→บอกว่าร้านไม่มีของ |
| CASH-3 | แคชเชียร์ | pay-partial ไม่กันกดซ้ำ → เน็ตช้ากดสองที บิลปิดที่ครึ่งราคา |
| CASH-4 | แคชเชียร์ | "ของเสีย" บนบิลจ่ายแล้ว ถูกบังคับเป็น refund → ลิ้นชักถูกหักผิด + ต้นทุนของเสีย ฿0 |
| CASH-5 | แคชเชียร์ | คืนเงินสดให้บิลจ่ายโอน ไม่หักลิ้นชัก → ลิ้นชักขาด แคชเชียร์โดนกล่าวหา |
| CASH-6 | แคชเชียร์ | แคชเชียร์กดราคาต่ำเองได้ ไม่ขึ้นในควบคุมการลดยอด (แม้คอมเมนต์บอก audited) |
| ACC-F3 | บัญชี | ค่าคอมมิชชั่นเดลิเวอรี่ไม่เข้า P&L เลย (Grab 30% หาย) |
| ACC-F4 | บัญชี | รายงานผูกชื่อเมนู ไม่ใช่ id → เปลี่ยนชื่อเมนู ตัวเลขวันเก่าเพี้ยน + 2 หน้าขัดกัน |
| ACC-F9 | บัญชี | ปุ่ม "เริ่มต้นใหม่" ลบบิล/ยอด/รอบเงินสด แต่ไม่ลบสต๊อก → ต้นทุนค้างเป็นผีตลอด |
| SEC-H1 | ความปลอดภัย | `/api/customers/:lineUserId/orders` ไม่ต้องล็อกอินสำหรับ LINE id (รู้ userId = อ่านประวัติเหยื่อ) |
| SEC-M5 | ความปลอดภัย | dependency มีช่องโหว่ 6 ตัว (3 high) — `npm audit fix` |
| PAY-H1/H2/H3 | ลูกค้า | สลับไปแอปธนาคารกลับมา QR หาย · countdown ปลอม · หมดเวลาแล้วไม่บอกเหตุผล |
| OWN-1 | เจ้าของ | ปุ่มเปิด "จ่ายออนไลน์/LINE Pay" โชว์เปิดแต่ถ้า env PAY_ONLINE ปิด = เงียบไม่มีผล |
| INF-R1 | ระบบ | โควตา read Turso หมดซ้ำ → deploy ตาย (boot pull เต็ม DB × 2 process/deploy) |
| INF-R2 | ระบบ | cold start 32 วิ บนแผนฟรี (วัดจริง) |
| PERF-H9 | ลูกค้า | รูป ~4.2 MB บน 2 จอที่เข้ามากสุด → เมนูโหลด ~23 วิบน 3G |

### 🟡 MEDIUM (คัดที่กระทบจริง)
- **CUS-H7** Back button ออกจากแอป+ตะกร้าหายทุกที่ · **CUS-H6** คูปองใช้ได้ดีสุดถูกดันไปอันดับ 9 ใต้คูปองหมดอายุ · **CUS-H8** input <16px → iOS zoom ค้างกลางจ่ายเงิน
- **CASH-9** sale_events รวมยอดไม่ได้ (partial+paid = นับซ้ำ) · **CASH-10** รับ method มั่วได้ (`banana`)
- **ACC-F5** จ่ายแยกช่องทาง drawer/tender ผิด · **ACC-F6** 2 หน้าโชว์ส่วนลดวันเดียวกันไม่ตรง · **ACC-F7** ไม่มีชื่อคนทำใน sale_events (กันโกงใช้ไม่ได้) · **ACC-F11** รอบข้ามเที่ยงคืนรวม 2 วัน
- **SEC-M3** branchIds เก็บไว้แต่ไม่บังคับใช้ · **SEC-M4** cookie ไม่มี Secure · **SEC-M1/M2** เชื่อ lineUserId จาก body ไม่ใช่ token
- **OWN-2/3** เพิ่มพนักงานไม่มีช่องค่าแรง+เลือกสาขา
- **INF-R4** reset เที่ยงคืนพลาดถ้าเครื่องหลับ · **INF-R5** LINE push พังเงียบ · **INF-R6/R7** clearTransactions/reset global + in-memory state = ระเบิดเวลา multi-branch
- a11y: tap target <44px, contrast ปุ่มหลัก 2.44:1 ตก AA, scroll lock 4 overlay ขาด
- **ภาษี**: ไม่มี VAT/ใบกำกับภาษี/เลขที่ใบเสร็จต่อเนื่อง — ยังจด VAT ไม่ได้

---

## แผนแก้เป็นเฟส

### Phase 0 — เจ้าของทำทันทีบน Render (ไม่ใช่โค้ด, กันความเสี่ยงที่เปิดอยู่)
1. ตั้ง `CASHIER_PIN` (ไม่ใช่ 1234) บน prod + UAT — แก้ SEC-C2
2. ตั้ง `SESSION_SECRET` (สุ่มยาว) บน prod + UAT — แก้ SEC-C3 (**ต้องตั้งก่อน** deploy โค้ดที่ถอด fallback ไม่งั้นคน logout ยกแผง)
3. ยืนยันแพลน Turso + ตั้ง quota alert 80% — แก้ INF-R1
4. เปิด external uptime pinger (ฟรี) — แก้ INF-R2

### Phase 1 — โค้ดวิกฤติ (เงิน+ความปลอดภัย+ทางตัน) → verify → cut to prod
- SEC: `trust proxy: 1` + คีย์ lockout จาก socket IP · cookie `Secure` · `npm audit fix`
- CASH-2: บล็อกลดราคาเมื่อ paid (ต้อง refund+คีย์ใหม่) · CASH-3: idempotency token บน pay-partial · CASH-4: ให้ waste บนบิล paid เป็น waste จริง · CASH-1/CASH-5: บันทึกเงินสดต่อ leg + คืนเงินสดหักลิ้นชัก
- CUS-C1: คืนจอในสาขา noshow_blocked · CUS-C2: บล็อกสั่งเมนู soldout ในบล็อก customer-price · CUS-C3/C4: แปล error เป็นไทย + แยก network-fail จากเมนูว่าง
- ACC-F2: waste/packaging ไม่คิดซ้ำ · ACC-F3: ใส่บรรทัด commission ใน P&L · ACC-F4: join itemSales ด้วย menu_item_id

### Phase 2 — HIGH
- ACC-F1: เพิ่ม `unit_cost` ลง stock_moves ตอน insert (cost layer) · ACC-F9: ให้ reset-transactions ลบ/รีเซ็ตสต๊อกด้วย หรือบล็อกเมื่อมีสต๊อก
- SEC-H1: ยืนยัน LIFF idToken ฝั่งเซิร์ฟเวอร์ทุกจุดที่ใช้ตัวตนลูกค้า
- PAY: persist วิธีจ่าย+QR ข้าม reload · countdown ผูก deadline จริง · resume ตั๋ว cancelled บอกเหตุผล
- PERF-H9: ย่อรูปเป็น WebP (~4.2MB→~450KB)
- INF: ถอด `npm run seed &&` ใน prod + seed non-fatal · sync 60s→300s · persistent disk · co-locate DB → Singapore · guard reset เที่ยงคืน · monitor push_log

### Phase 3 — MEDIUM + เตรียม SaaS
- บังคับ branch scope ทุก query ที่ไม่ใช่ owner · scope clearTransactions/reset ต่อ tenant/branch (**บล็อกก่อนเปิดสาขา 2**)
- คูปอง sort ใช้ได้ก่อน+ซ่อนหมดอายุ · a11y (tap 44px, contrast, input 16px) · back-button + cart ลง sessionStorage
- ระบบใบกำกับภาษี/VAT/เลขที่ใบเสร็จต่อเนื่อง (ก่อนจด VAT)
- monitoring ครบ (uptime, deploy-fail, quota, error rate, push-fail, backup verify)

---

## สิ่งที่ผ่านการตรวจ (ไม่ต้องตรวจซ้ำรอบหน้า)
ราคาเสิร์ฟฝั่งเซิร์ฟเวอร์ · เจ้าของตั๋วกันข้ามคน · กันกดซ้ำสร้าง/จ่ายเต็ม/แลกแต้ม · แข่งกันกดพร้อมกัน · เสิร์ฟก่อนจ่าย/จ่ายหลัง void ถูกบล็อก · กู้คืนบิลหมดเวลา · escaping/XSS · webhook signature · backup ไม่รวม PIN hash · ปิดพนักงานตัดสิทธิ์ได้ · security headers · ยอดขาย/เงินสด/Z-report ตรงทุกสตางค์ · ไม่นับซ้ำ merge/partial/แลกแต้ม · Bangkok +7 boundary · archiveTodaySales idempotent · ไม่มี dead setting · ปุ่ม 298 ตัวไม่มีตัวตาย · รายงานโหลด+กรอง+export ได้ · CRM แสดงผลส่งจริง · claim-link ครบ 7 สถานะ · เหตุผลคูปองใช้ไม่ได้อธิบายชัด · birthday validation · ไม่มี horizontal scroll · zoom ไม่ถูกบล็อก · rating กันกดซ้ำ · durability sync triggers ครบ · SSE fan-out O(1)

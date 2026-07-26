# SaaS Readiness — อะไรควรเป็น "ตั้งค่าได้" อะไรควร "ฝังในโค้ด" (2026-07-27)

ตอบคำถามเจ้าของ: *"สิ่งไหนควรเป็น setting สิ่งไหนควร hardcode เพื่อเตรียมส่งมอบเป็น SaaS"*
สำรวจจากโค้ดจริงทั้ง `server/` — ทุกแถวคือของที่มีอยู่จริง ไม่ใช่ทฤษฎี

## หลักการแบ่ง 3 ชั้น

| ชั้น | ใครแก้ | ตัวอย่าง |
|---|---|---|
| **A. Per-tenant setting** (ตาราง `settings` / หน้า ⚙) | เจ้าของร้านแต่ละราย แก้เองได้ | เวลาเปิดร้าน, แต้มสะสม, เพดานแคมเปญ |
| **B. Per-deploy env** (Render environment) | ผู้ให้บริการ (เรา) ตอนติดตั้งให้ลูกค้า | LINE credentials, DB, โดเมน |
| **C. Product constant** (ฝังในโค้ด) | ทีมพัฒนาเท่านั้น — เหมือนกันทุกร้าน | กติกาความปลอดภัย, สูตรบัญชี |

กติกาชี้ขาด: **ถ้าร้านสองร้านอยากได้ค่าไม่เท่ากัน → ต้องเป็น A** ·
**ถ้าค่าผูกกับบัญชีภายนอกของร้านนั้น → B** · **ถ้าเปลี่ยนแล้วความหมายของระบบเปลี่ยน → C**

## 1) ที่ถูกที่แล้ว — เป็น per-tenant setting อยู่แล้ว (ชั้น A ✅)

เวลาเปิด-ปิดร้านรายสาขา · เปิด/ปิดสะสมแต้ม + `loyalty:stamps_per_reward` (10) ·
บัตรสมาชิก on/off · ช่องทางชำระ + ค่าธรรมเนียม% · เพดานดึงลูกค้ากลับ/เดือน (100) ·
แคมเปญวันเกิด/เลขนำโชค on/off + ผูกคูปอง (`tpl:*:coupon_id`) · Queue-first ·
social proof / mascot / PDPA notice · โปรโมแบนเนอร์ · ต้นทุนการเงินทั้งชุด (% วัตถุดิบ,
ค่าแรง, ค่าเช่า, daysPerMonth…) · SlipOK toggle · นาที auto-pause POS offline

## 2) ควร "ย้ายขึ้น" เป็น setting ก่อนขาย SaaS (ตอนนี้ hardcode → ชั้น A)

| ค่า | ตอนนี้อยู่ที่ | ค่า | เหตุผลที่ร้านอื่นอยากต่าง |
|---|---|---|---|
| มูลค่า/อายุคูปองแม่แบบ fallback | `TPL_DEFS` ใน queue.js | ฿100/฿49, 30 วัน | ราคาสินค้าแต่ละร้านไม่เท่ากัน (ผูกคูปองแล้ว override ได้ แต่ fallback ยังฝังโค้ด) |
| เพดานเครื่องดื่มฟรี (reward cap) | ฝังใน db.js/queue.js | ฿49 | ร้านกาแฟแก้วละ ฿120 ใช้ ฿49 ไม่ได้ |
| ระยะพักส่ง win-back ซ้ำคนเดิม | `WINBACK_COOLDOWN_DAYS` | 45 วัน | ความถี่การตลาดเป็นนโยบายร้าน |
| นิยาม "ลูกค้าเสี่ยงหาย" (วันที่ห่างหาย) | ฝังใน segment SQL | — | ร้านขายรายเดือน vs รายวัน นิยามต่างกัน |
| เวลารอ/กลุ่มคิว | env `WAIT_PER_GROUP_MIN` | 4 นาที | เป็นจังหวะการผลิตของร้าน ไม่ใช่ของ deploy → ย้าย env → setting |
| จุดแจ้งเตือน "อีก N คิวถึงตา" | env `NOTIFY_THRESHOLD` | 2 | เหตุผลเดียวกัน |
| อายุ retention (push log 90 วัน / สลิป 30 / sale events 400) | `RETAIN` ใน queue.js | — | แพ็กเกจ SaaS ถูก-แพงเก็บไม่เท่ากัน — ผูกกับ plan ได้ |

## 3) ถูกแล้วที่เป็น per-deploy env (ชั้น B ✅ — ห้ามย้ายเข้า DB)

Credentials ทั้งหมด: `LINE_CHANNEL_ACCESS_TOKEN/SECRET`, `LIFF_ID`, `LINE_ADD_FRIEND_URL`,
`LINEPAY_*`, `SLIPOK_*`, `OCR_API_*`, `TURSO_DATABASE_URL/AUTH_TOKEN`, `SESSION_SECRET`,
`CASHIER_PIN`/`OWNER_PIN` (ค่าเริ่มต้นตอนติดตั้ง), `PUBLIC_BASE_URL`, `PORT`,
`PROMPTPAY_ID`/`PROMPTPAY_STATIC`, `PAY_ONLINE`, `SELF_ORDER`, `PACKAGE`, `QUEUE_DATA_DIR`, `SEED`

**Brand (`BRAND_NAME/SHORT/THEME/LOGO/UNIT`)**: วันนี้เป็น env = white-label ต่อ deploy ได้แล้ว
พอเป็น multi-tenant จริง (หลายร้านใน DB เดียว) ต้องย้ายเป็นคอลัมน์ของ `stores`/tenant —
มี `tenant_id` รออยู่ทุกตารางแล้ว

⚠️ กติกาเหล็ก: **secret ห้ามอยู่ในตาราง settings** — settings ถูก export ใน backup ที่เจ้าของดาวน์โหลดได้

## 4) ถูกแล้วที่ฝังในโค้ด (ชั้น C ✅ — อย่าทำเป็น setting)

- กติกาความปลอดภัย: PIN lockout (8 ครั้ง/3 นาที), rate limits (30/นาที ฯลฯ), security headers,
  session 12 ชม. — เปิดให้ตั้งเอง = เปิดช่องปิดการป้องกัน
- สูตรบัญชี: ลำดับ P&L (COGS→GP→EBITDA→ภาษี), Bangkok `+7 hours`, การปัดเศษ ×100/100,
  actual-over-plan (แรงงาน/วัตถุดิบ) — เปลี่ยนแล้วรายงานทุกร้านเทียบกันไม่ได้
- โครงสร้างข้อมูล: สถานะ ticket/order, ชนิดคูปอง (birthday/winback/reward/lucky/claim),
  unique index กันเคลมซ้ำ, migration แบบ additive
- ขีดจำกัดกันพัง: comment 500 ตัวอักษร, ชื่อ 80, body 2MB, pagination

## 5) สิ่งที่ต้องทำก่อนเปิด multi-tenant จริง (จาก audit เดิม — ยังเป็น blocker)

1. **Branch/tenant scoping ของคำสั่งล้างข้อมูล** — `clearTransactions` และ zone reset ยังไม่มี
   WHERE tenant → ร้านหนึ่งกดล้าง สะเทือนทุกร้าน (บันทึกไว้ใน SYSTEM-AUDIT-2026-07-26.md)
2. ย้าย BRAND เข้าตาราง (ข้อ 3) + ค่าในตาราง §2 ขึ้นหน้า ⚙
3. `cogsForDay` / stock ledger ยังไม่กรอง branch — P&L สาขาใช้ค่าประมาณไปก่อน (จงใจ กันตัวเลขผิด)
4. รายชื่อ settings ต่อ tenant ต้อง seed ตอนสร้างร้านใหม่ (มี default ครบใน db.js แล้ว)

## 6) ลำดับแนะนำ (effort ต่ำ→สูง)

1. ย้าย 3 ค่า marketing (reward cap ฿49, winback cooldown, TPL fallback) ขึ้นหน้า ⚙ — ครึ่งวัน
2. ย้าย `WAIT_PER_GROUP_MIN` + `NOTIFY_THRESHOLD` จาก env → settings — ครึ่งวัน
3. RETAIN ผูกกับ `PACKAGE` env — 1 ชม.
4. tenant-scope คำสั่งล้างข้อมูล — 1 วัน + ทดสอบหนัก (ทำก่อน merge เข้า branch `saas`)
5. BRAND → ตาราง stores — 1 วัน (รวมแก้ manifest/config route)

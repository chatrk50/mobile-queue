# White-label Template Plan — POS + Queue (2 packages)

**เป้าหมาย:** ทำให้ระบบนี้เป็น **template ติดตั้งให้แบรนด์อื่นได้** ด้วยฟีเจอร์เดียวกัน แบ่งขายเป็น **2 แพ็กเกจ**:
- **Pkg 1 — Mobile POS** (แคชเชียร์ + คิว + รายงาน, ไม่มี LINE)
- **Pkg 2 — LINE Connecting** (เพิ่มลูกค้าสั่งผ่าน LINE/LIFF + แจ้งเตือน + สะสมแต้ม)

---

## 1) สถานะปัจจุบัน — พร้อมแล้วแค่ไหน

| ส่วน | สถานะ template |
|---|---|
| LINE/LIFF/แจ้งเตือน | ✅ เป็น env ทั้งหมด (`LIFF_ID`, `LINE_CHANNEL_*`, `SELF_ORDER`) — **ปิดได้ = Pkg 1** |
| จ่ายออนไลน์ (พร้อมเพย์/LINE Pay/SlipOK) | ✅ env (`PAY_ONLINE`, `PROMPTPAY_*`, `SLIPOK_*`, `LINEPAY_*`) |
| ฐานข้อมูล (แยกต่อแบรนด์) | ✅ env (`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`) — 1 แบรนด์ = 1 DB |
| เมนู · สาขา · ต้นทุน · สูตร · พนักงาน · ตั้งค่า | ✅ อยู่ใน DB (เจ้าของแก้เองได้) |
| โครง multi-tenant | ✅ มี `tenant_id` ทุกตาราง (default 1) — เป็น insurance ไว้ |
| **ชื่อแบรนด์/โลโก้/สี/คำพูด** | ❌ **hardcode "YO-DEE Yogurt" ~63 จุด** + โลโก้ไฟล์ + สี `#1e3a5f` + manifest — **ต้องดึงเป็น config** |
| **หน่วยสินค้า** ("แก้ว") | ❌ ผูกกับโยเกิร์ต — ทำให้ตั้งได้ (แก้ว/ถ้วย/ชิ้น) สำหรับสินค้าอื่น |
| Loyalty (สะสมแต้ม) | ⚠️ ผูกกับ `line_user_id` → ใช้ได้เฉพาะ Pkg 2 (Pkg 1 ปิด หรือผูกเบอร์โทรภายหลัง) |

---

## 2) สถาปัตยกรรมที่แนะนำ — "1 แบรนด์ = 1 instance" (Per-brand)

**แนะนำ Model A:** แต่ละแบรนด์ได้ **Render service + Turso DB + env + โลโก้ของตัวเอง** แยกขาด
- ✅ แยกข้อมูลเด็ดขาด (ไม่มีทางข้ามแบรนด์) · ปลอดภัยเรื่องเงิน/PDPA
- ✅ ระบบ**เป็นแบบนี้อยู่แล้ว 80%** — ลงแบรนด์ใหม่ = ตั้ง env + โลโก้ + DB + deploy
- ✅ แต่ละแบรนด์เปิด/ปิดฟีเจอร์ของตัวเองได้ (toggle ใน ⚙)

**Model B (Multi-tenant SaaS ใน instance เดียว)** — เก็บไว้อนาคต: ใช้ `tenant_id` enforcement + routing ตามโดเมน ซับซ้อนกว่ามาก (ต้อง scope ทุก query + auth ต่อ tenant + กันข้อมูลรั่ว) ยังไม่จำเป็นถ้ายังไม่กี่สิบร้าน

---

## 3) แบ่ง 2 แพ็กเกจ (เป็น "ชุด env preset" ของ Model A)

### 📦 Pkg 1 — Mobile POS (สแตนด์อโลน)
**มี:** สั่งหน้าร้าน (split-screen) · คิว/จอแสดงคิว · จ่ายเงิน (สด+ทอน / พร้อมเพย์แสกน) · รายงาน + **P&L วัน/เดือน/ปี** · สต๊อก/BOM · พนักงาน/สิทธิ์ · ปิดกะ/Z-report · หลายสาขา · queue-first toggle
**ไม่มี:** ลูกค้าสั่งผ่าน LINE · แจ้งเตือน LINE · สะสมแต้ม (LINE-keyed)
**เปิดด้วย:** ไม่ตั้ง LINE env · `SELF_ORDER=0` · ลูกค้ารับเลขคิวจากจอ/ปริ้น

### 📦 Pkg 2 — LINE Connecting (add-on ของ Pkg 1)
**เพิ่ม:** LIFF ลูกค้าสแกน QR สั่งเอง · แจ้งเตือน LINE (รับคิว/ใกล้ถึง/เสิร์ฟ) · **ระบบยกเลิก (cancel-request)** · สะสมแต้ม/ของรางวัล/วันเกิด/ชวนเพื่อน · (ทางเลือก) จ่ายออนไลน์ พร้อมเพย์/LINE Pay/SlipOK
**เปิดด้วย:** ตั้ง `LIFF_ID` + `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET` + `SELF_ORDER=1` (+ `PAY_ONLINE=1` ถ้าจะรับเงินออนไลน์)

> **การแยกแพ็กเกจ = แค่ชุด env** (โค้ดเดียวกัน) — Pkg 2 คือ Pkg 1 + เปิด LINE env

---

## 4) งานที่ต้องทำเพื่อ "ทำให้เป็นแบรนด์กลาง" (เรียงเฟส)

**เฟส A — Brand config (สำคัญสุด)**
- ดึง hardcode เป็น env: `BRAND_NAME`, `BRAND_SHORT`, `BRAND_THEME` (สีหลัก), `BRAND_LOGO` (path/URL)
- `/api/brand` endpoint ให้ทุกหน้า (cashier/liff/display/status/print) อ่านชื่อ+โลโก้+สีมาแสดง
- สร้าง `manifest.webmanifest` จาก brand config (ชื่อ/ไอคอน/สี)
- แทนที่ "YO-DEE Yogurt" ~63 จุด → อ่านจาก brand config · "YO-DEE order" (LINE Pay product) → `${BRAND_NAME} order`

**เฟส B — Theme + หน่วยสินค้า**
- CSS vars (`--navy`/`--accent`) inject จาก `BRAND_THEME` → เปลี่ยนสีทั้งแอปด้วยค่าเดียว
- `BRAND_UNIT` ('แก้ว'/'ถ้วย'/'ชิ้น') แทน "แก้ว" ในรายงาน/หน้าจอ (รองรับกาแฟ/อาหาร)

**เฟส C — Feature-flag audit (Pkg 1 ต้องสะอาด)**
- ตรวจว่าปิด LINE แล้ว **ไม่มีปุ่ม/หน้า LINE โผล่** (ส่วนใหญ่ gate ด้วย `CFG.lineEnabled`/`selfOrder`/`promptPay` อยู่แล้ว — audit ให้ครบ)
- Loyalty: ซ่อนทั้งหมดเมื่อไม่มี LINE (หรือทำ phone-key mode ภายหลัง)

**เฟส D — Onboarding template**
- `brand.env.example` (2 ชุด: pos-only / line) + checklist
- (ทางเลือก) script ช่วยตั้ง: สร้าง Turso DB → ใส่ env → ตั้งโลโก้ → deploy
- seed เริ่มต้นแบบ "ว่าง/ทั่วไป" (ไม่ใช่เมนูโยเกิร์ต) ให้เจ้าของกรอกเมนูเอง

---

## 5) Checklist ลงแบรนด์ใหม่ (Model A)

**ทั้ง 2 แพ็กเกจ:**
1. สร้าง Turso DB ใหม่ (ของแบรนด์นั้น) → ได้ URL + token
2. สร้าง Render web service จาก repo (หรือ fork) → region Singapore
3. ตั้ง env: `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, `SESSION_SECRET`, `OWNER_PIN`, `PUBLIC_BASE_URL`, `BRAND_NAME`/`BRAND_SHORT`/`BRAND_THEME`
4. วางโลโก้แบรนด์ (`/assets/logo.png` หรือ `BRAND_LOGO` URL)
5. เปิด keep-alive (GitHub Action) → กัน cold-start
6. เจ้าของล็อกอิน → กรอกเมนู/สาขา/ต้นทุน/พนักงาน

**เพิ่มสำหรับ Pkg 2 (LINE):**
7. สร้าง LINE OA + LINE Login channel + LIFF app → ได้ `LIFF_ID` + token + secret
8. ตั้ง env LINE + `SELF_ORDER=1` → ตั้ง webhook URL ที่ LINE
9. (ถ้ารับเงินออนไลน์) `PAY_ONLINE=1` + พร้อมเพย์ร้านค้า / SlipOK / LINE Pay merchant

---

## 6) เรื่องที่ต้องตัดสินใจ (ก่อนลงมือ)
- **โมเดลขาย:** ขายแบบ "ติดตั้งให้ (one-time + ดูแลรายเดือน)" หรือ "SaaS subscription"? → ชี้ว่าจะไป Model A นานๆ หรือ Model B ในอนาคต
- **Pkg 1 มี loyalty ไหม?** ถ้าต้องมี → ทำ phone-number key (งานเพิ่ม) · ถ้าไม่ → loyalty เป็นจุดขายของ Pkg 2
- **โฮสติ้ง:** Render ต่อแบรนด์ (ง่าย) หรือรวมศูนย์? · DB Turso ต่อแบรนด์ (แยกขาด ✅)
- **Repo:** 1 repo + env ต่างกัน (แนะนำ) หรือ fork ต่อแบรนด์?

---

## สรุป
ระบบ**พร้อมแยก 2 แพ็กเกจด้วย env อยู่แล้ว** — งานหลักที่เหลือคือ **เฟส A (brand config)** ดึงชื่อ/โลโก้/สีออกจากโค้ด ~63 จุด แล้วลงแบรนด์ใหม่ได้ใน ~1-2 ชั่วโมง/แบรนด์ · เริ่มที่เฟส A ได้เลยเมื่อพร้อม

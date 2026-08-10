# แผนตรวจสอบระบบเต็มรูปแบบ (6 บทบาท) — สถานะและวิธีทำต่อ

เริ่ม 2026-08-10 ตามคำสั่งเจ้าของ: "วางแผนการตรวจสอบอย่างเป็นระบบให้ครบทุก scenario ทุกบทบาท"
ทีมตรวจ 6 ชุดถูกปล่อยพร้อมกันแล้ว **ตายทั้งหมดตั้งแต่เพิ่งเริ่ม** เพราะ session limit หมด
เอกสารนี้เก็บแผน + สิ่งที่ตรวจไปแล้ว เพื่อ resume ต่อโดยไม่ต้องเริ่มใหม่

## บทบาทที่ต้องตรวจ (แต่ละชุดรัน instance แยก ห้ามแก้ไฟล์ ห้ามแตะ prod)

| # | บทบาท | port | ขอบเขตย่อ | สถานะ |
|---|-------|------|-----------|-------|
| 1 | เจ้าของร้าน | 3181 | setup วันแรก, ทุกหน้า settings (dead setting / ควรเป็น setting), CRM, รายงานทุกใบ vs ข้อมูลดิบ, role gates, ปุ่มตาย | ⏸ ยังไม่เริ่ม |
| 2 | แคชเชียร์ | 3182 | เปิด-ขาย-ปิดเต็มวัน, พักบิล/แยกจ่าย/รวมบิล, void/refund/ของเสีย/กู้คืน, กดซ้ำ+2 เครื่องพร้อมกัน, Z-report ตรงไหม | ⏸ |
| 3 | ลูกค้า | 3183 | ทุกประเภท (LINE/ใหม่/guest/ขาประจำ/วันเกิด/ถูกบล็อก/เน็ตช้า), ครบเส้นทางสั่ง→จ่าย→รับ→รีวิว, คูปองทุกสถานะ, a11y+mobile จริง | ⏸ |
| 4 | ผู้ตรวจสอบบัญชี | 3184 | สร้าง ledger สมมติแล้วพิสูจน์ด้วย SQL: รายได้/กระทบยอด/เงินสด/P&L/COGS/audit trail/เส้นแบ่งวัน UTC+7/ช่องว่าง VAT | ⏸ |
| 5 | ความปลอดภัย | 3185 | route×tier, IDOR, SQLi/XSS, โกงราคา/ฟาร์มคูปอง, LINE signature, PDPA, DoS, npm audit | 🟡 เริ่มแล้ว (ดูล่าง) |
| 6 | ระบบ+เน็ตเวิร์ก+อนาคต | — | RPO/RTO, **โควตา Turso หมด → กันซ้ำ+เตือนล่วงหน้า**, latency Tokyo↔Singapore, job/timer, แผนขยาย 5→50→500 ร้าน, monitoring | ⏸ |

## ผลที่ได้แล้ว (บทบาท 5 — บางส่วน)

### ตารางสิทธิ์ทุก route (server/index.js, 196 routes)

| ระดับ | จำนวน |
|-------|-------|
| manager | 90 |
| staff (pinOK) | 37 |
| owner | 28 |
| customer-checked | 15 |
| เปิด + rate limit | 7 |
| **เปิดสาธารณะล้วน** | **19** |

19 ตัวที่เปิดล้วน (ไม่มี guard ไม่มี rate limit):
`POST /line/webhook` · `GET /manifest.webmanifest` · `GET /api/config` · `POST /api/menu/:id/like` ·
`GET /api/menu-likes` · `POST /api/consent` · `GET /api/stores` · `GET /api/stores/:storeId/zones` ·
`GET /api/zones/:zoneId` · `GET /api/qr/:zoneId` · `GET /api/member-qr` · `GET /api/promptpay-qr` ·
`GET /api/zones/:zoneId/snapshot` · `POST /api/zones/:zoneId/my-ticket` · `GET /api/tickets/:ticketId` ·
`POST /api/tickets/:ticketId/cancel` · `GET /api/linepay/confirm` · `POST /api/tickets/:ticketId/claim` ·
`GET /api/zones/:zoneId/stream`

ส่วนใหญ่ต้องเปิดจริงตามธรรมชาติ (ลูกค้าไม่มี login) — ที่ต้องพิจารณาต่อ:

- **`POST /api/tickets/:ticketId/cancel`** — ตรวจความเป็นเจ้าของแล้ว (`queue.js` customerRequestCancel:
  `t.line_user_id !== lineUserId → not_your_order`) **แต่รับ lineUserId จาก body ไม่ใช่ token ที่ยืนยัน**
  → ใครรู้ userId ของเหยื่อ ยกเลิกออเดอร์เขาได้ ระดับ: กลาง (ต้องรู้ userId ก่อน)
- `POST /api/zones/:zoneId/my-ticket` — รูปแบบเดียวกัน (ค้นตั๋วจาก userId ใน body)
- `GET /api/member-qr`, `GET /api/promptpay-qr` — สร้างรูปทุกครั้ง ไม่มี rate limit → DoS ราคาถูก
- `GET /api/tickets/:ticketId` — เดินเลข id ดูออเดอร์คนอื่นได้ (พบซ้ำจาก audit รอบก่อน)
- `POST /api/menu/:id/like`, `POST /api/consent` — เขียน DB ได้ไม่จำกัดจำนวน

## วิธี resume (สำหรับเซสชันถัดไป)

ปล่อย agent ทีละ 1–2 ตัว (ห้ามปล่อย 6 ตัวพร้อมกันอีก — กิน budget จนตายทั้งชุด) เรียงตามลำดับ:
บัญชี (4) → แคชเชียร์ (2) → ความปลอดภัย (5, ต่อจากตารางข้างบน) → ลูกค้า (3) → เจ้าของ (1) → ระบบ/อนาคต (6)

ทุก prompt ต้องระบุ: repo path, port เฉพาะตัว, scratch dir แยก, `x-cashier-pin: 1234`,
"ห้ามแก้ไฟล์ที่ track / ห้ามเขียน prod", และ **"ห้ามรายงานสิ่งที่ไม่ได้ทดสอบจริง + ต้องแนบ file:line + วิธีทำซ้ำ + ระบุสิ่งที่ผ่านด้วย"**

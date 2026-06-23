# KhaiDee (ขายดี) — Go-to-Market & Launch Plan

_Platform brand: **ขายดี / KhaiDee**. YO-DEE Yogurt is the first live tenant + case study._
_See also: [GTM-PRICING.md](GTM-PRICING.md), [COMPETITIVE-LINE-MINI-EATS.md](COMPETITIVE-LINE-MINI-EATS.md),
[PROJECT-ROADMAP.md](PROJECT-ROADMAP.md)._

## 1. Positioning (the one thing)
> **ระบบของ "ร้านขายดี" — จัดคิว + รับออเดอร์ผ่าน LINE ให้ลูกค้ากลับมาซื้อตรง โดยไม่หักค่าคอม
> เปิดใช้เองใน 1 นาที เริ่มฟรี**

The wedge is **queue + own-your-customer**, sharpened by **price + radical self-serve**:
- vs **delivery marketplaces** (Grab / LINE MAN): they take ~30% and own the customer. KhaiDee = 0%
  commission, the shop owns its LINE/loyalty base. Frame as a **co-pilot**: delivery finds new
  customers; KhaiDee brings them back direct.
- vs **LINE MINI Eats** (0% GP too, ฿1,390/mo, Wongnai-tied): KhaiDee wins on **price (free / ฿299),
  a real queue system, 1-minute self-serve, works without LINE, and ecosystem independence**. Don't
  fight LINE on distribution.

Backed by data: **65–80% of restaurant revenue is from regulars**; **78% return for rewards**; direct
orders give the shop the customer relationship that platforms otherwise keep.

## 2. Who it's for (ICP)
Grab-and-go Thai F&B where the queue is the pain and regulars are the business:
**ร้านเครื่องดื่ม/ชานม · คาเฟ่/กาแฟ · ของหวาน/โยเกิร์ต · สตรีทฟู้ด/ตามสั่ง · เบเกอรี่** — especially the
micro / long-tail shops for whom ฿1,390/mo is too much and who don't need the Wongnai ecosystem.

## 3. Pricing (recap)
Free (1 branch) · **Pro ฿299/mo** (3 branches, LINE+loyalty, ฿2,990/yr) · Business ฿799/mo (unlimited,
custom domain, ฿7,990/yr). **Founder-50: Pro ฿199/mo locked for life** + concierge setup. 60-day Pro
trial, no card. Margin ~85% after VAT/hosting/Omise.

## 4. Phased launch
- **Phase 0 — Ready (now):** product + brand done (landing/funnel/help on-brand, savings calculator,
  two-sided demo, comparison). **Close go-live blockers (owner — §7).**
- **Phase 1 — Founder-50 (soft launch):** lead with the **YO-DEE case study** (the single best asset).
  Recruit 50 founder shops via FB F&B/คาเฟ่-owner groups + LINE OA + word-of-mouth; **concierge onboard**
  (esp. the LINE setup wall). Goal: 50 active shops, ≥10 testimonials.
- **Phase 2 — Growth:** turn on the **referral program** (built: both sides +30d); publish content
  (how queue + LINE-reorder lifts sales; the commission-saving math from the calculator); push the
  **vertical starter-menu templates** (built) for 1-tap activation.
- **Phase 3 — Scale:** partnerships (LINE OA agencies, POS/thermal-printer resellers); paid acquisition
  once unit economics proven; add the adopt-backlog features (§8).

## 5. Channels & first-weeks content
- **FB groups** for Thai café/F&B owners — the case study + the savings calculator as a lead magnet.
- **LINE OA** (KhaiDee's own) — broadcast tips + onboarding help; the support channel (`SUPPORT_LINE_URL`).
- **Short Thai how-to videos** — "เปิดร้านขายได้ใน 1 นาที", "ให้ลูกค้าสั่งผ่าน LINE + รับคิว".
- **The landing** is the hub: hero → demo → calculator → comparison → signup.

## 6. Messaging pillars
1. ระบบของ **ร้านขายดี** (brand = the aspiration) · 2. **คิว + LINE** (the wedge) ·
3. **ไม่หักคอม · ลูกค้าเป็นของร้านคุณ** (vs marketplaces) · 4. **เปิดเองใน 1 นาที · เริ่มฟรี** (vs LINE MINI Eats).

## 7. Go-live blockers (OWNER — I can't do these)
- [ ] Always-on hosting (Render Starter — free tier sleeps)
- [ ] Live Omise keys + one real test charge end-to-end
- [ ] Env: set `SUPPORT_LINE_URL` (+ optional `SAAS_ADMIN_TOTP_SECRET` for admin 2FA)
- [ ] Legal entity to invoice/collect · DPA template · VAT-trigger plan (>฿1.8M/yr)
- [ ] Staffed LINE OA support channel · uptime + error monitoring
- [ ] Glance at the first CI run (GitHub Actions)

## 8. Product backlog adopted from the LINE MINI Eats study
1. **Promo scheduling + LINE broadcast** to the owned customer base (re-engagement).
2. **Formal, configurable membership tiers** (we have stamps + badge tiers — package as a program).
3. **Polished branded shop homepage** in the LIFF (we have theming — elevate to a profile page).

## 9. Funnel & metrics to watch
visit → **signup** → **activation** (first menu item / first paid order) → **trial → paid** → **referral**.
Early targets: activation ≥60% of signups; trial→paid ≥25%; ≥1 referral per 5 paying shops.

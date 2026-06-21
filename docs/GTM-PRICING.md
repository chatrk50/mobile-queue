# GTM, Pricing & Market Strategy — LINE-first POS/Queue SaaS (Thailand)

_Working strategy doc. Numbers are planning estimates (THB); competitor prices are approximate
and change — verify before quoting publicly._

---

## 1. Who we serve (keep this in front of every decision)
**Segment:** the smallest Thai F&B — market stalls, food trucks, dessert/drink kiosks, single
cafés. Owner-operated, **price-allergic**, low-tech, mobile-only, **customers already live in
LINE**, and many have a **visible queue**. (YO-DEE yogurt = the archetype.)

**Why this segment:** it is *underserved* — FoodStory/StoreHub are too expensive/restaurant-shaped;
Loyverse has no queue/no LINE ordering; QueQ/PointSpot each do only one piece. Nobody bundles
**queue + POS + LINE self-order + loyalty** for a ฿20k/day stall at a stall-friendly price.

---

## 2. Competitive brief (approx.)

| Player | Strength | ~Price/mo | Gap vs us |
|---|---|---|---|
| **Loyverse** | Free POS, huge base | Free + add-ons ~฿170–850 | No queue, no LINE ordering, EN-ish |
| **FoodStory** | Thai restaurant POS | ~฿900–1,500 | Pricey, dine-in focus, no queue/LINE order |
| **StoreHub** | POS+stock+QR order | ~฿1,500–2,500 + hardware | Pricey, hardware lock-in, not LINE-native |
| **PointSpot** | LINE loyalty | Free–~฿500 | Loyalty only (no POS/queue) |
| **QueQ** | Queue (restaurants/clinics) | B2B/enterprise | Queue only, not self-serve micro |
| **Page365/Zort** | Chat commerce + stock | Free–~฿1,500 | No queue/POS counter/P&L |
| **Grab/LINE MAN** | Delivery reach | **~30%/order commission** | Takes a cut of every sale; not the shop's own system |

**Positioning:** *the all-in-one LINE-native **queue + order + loyalty + POS** for stalls — one
app, no hardware, no per-sale commission, a third of the price.* You'd otherwise stitch
StoreHub + PointSpot + QueQ (>฿3,000/mo).

**Our edge:** all-in-one · LINE-native (no app download) · cheap, no hardware lock-in · Thai to
the unit ("แก้ว/จาน") · **queue is the wedge** · phone-key loyalty for walk-ins · shared
multi-tenant infra = high margin.
**Our honest gaps:** new/unproven brand · no support team yet · no delivery integration · no full
hardware (printer/drawer) · no e-Tax/accounting integration · free hosting sleeps · tiny team.

---

## 3. Cost stack (what eats the price)

Most cost is **shared/fixed** (one multi-tenant deployment serves all brands), so per-tenant COGS
is tiny. The variable costs are payment fees + VAT.

| Item | Type | Estimate | Notes |
|---|---|---|---|
| **App hosting** (Render) | fixed | ฿0 (free, sleeps) → **~฿250/mo** (Starter, always-on) → ฿900 (Standard) | Paying customers need always-on. ONE service for all tenants. |
| **Database** (Turso) | fixed | ฿0 (free: ~1B row-reads, 9GB) → ~฿1,000/mo (Scaler) when bigger | Generous free tier covers early stage. |
| **Domain (.com)** | fixed | ~฿40/mo (฿400–500/yr) | Tenant custom domains = tenant's own cost (or resold). |
| **Payment processing** (Omise) | variable | **~3.65%/charge** (card) | On ฿299 ≈ ฿11; on ฿2,990/yr ≈ ฿109. PromptPay cheaper. |
| **VAT** (once we register) | variable | **7%** of price | Mandatory once revenue > ฿1.8M/yr. Quote **VAT-inclusive**. |
| **LINE** (Messaging/LIFF) | — | ฿0 to us | Each tenant uses its **own** LINE channel (their quota/cost). |
| **Support / ops** | variable (labor) | the real swing cost | Minimize via self-serve onboarding + LINE OA + FAQ/video. |
| **Email/SMS, misc** | small | ~฿0–200/mo | Transactional only. |

**Total fixed infra early: ~฿300–1,500/mo** regardless of tenant count.

---

## 4. Unit economics & profitability (the important part)

Model at **Pro = ฿299/mo, VAT-inclusive**, after VAT registration + Omise card fee:

```
Gross price                         ฿299.00
− VAT 7% (inclusive → net/1.07)     −฿19.55   → net ฿279.45
− Omise ~3.65% of ฿299              −฿10.91
= Contribution / paying tenant      ≈ ฿268 / month   (~90% of net)
```
- **Before VAT registration** (early, < ฿1.8M/yr): contribution ≈ ฿288 (no VAT deducted).
- **Break-even:** fixed infra ฿300–1,500 ÷ ฿268 ≈ **2–6 paying tenants** covers all hosting/DB/domain.
- **At 100 paying tenants:** revenue ฿29,900/mo; costs ≈ VAT ฿1,955 + Omise ฿1,091 + infra ฿1,500
  = ฿4,546 → **gross profit ≈ ฿25,400/mo (~85% margin)** before support labor.
- **At 1,000 tenants:** ~฿299k/mo, ~85% gross margin; infra scales sub-linearly (one bigger DB/service).

**Verdict: ฿299 is comfortably profitable** even after VAT + payment + hosting + DB + domain. The
margin risk is **support labor at low scale**, not infra — so push annual (less churn/support),
self-serve onboarding, and a higher Business tier to subsidize.

Annual ฿2,990/yr: VAT net ฿2,794 − Omise ฿109 = ฿2,685/yr ≈ ฿224/mo contribution, but **cash
upfront + far lower churn/support** → better LTV. Always favor annual.

---

## 5. Pricing (straightforward, 3 tiers, VAT-inclusive)

| Tier | Price (incl. VAT) | For | Includes |
|---|---|---|---|
| **Free** (forever) | ฿0 | trial-that-never-ends, growth hook | 1 branch · queue + POS + cash/PromptPay · ≤500 orders/mo · today's sales · "powered by" · **no** LINE order/loyalty |
| **Pro** ⭐ | **฿299/mo** or **฿2,990/yr** (2 months free) | most stalls | unlimited orders · 1–3 branches · **LINE order + loyalty** · full P&L + charts + Excel · stock/BOM · online pay · no "powered by" |
| **Business** | **฿799/mo** or **฿7,990/yr** | multi-branch / chains | unlimited branches · full staff roles · custom domain · cross-branch reports · priority support |

Rationale: ฿299 sits under the ~฿500 psychological wall, 3–5× cheaper than FoodStory/StoreHub,
yet bundles more → fast adoption with healthy margin. Business tier captures the few high-value
multi-branch accounts that fund support.

> **In code today:** Free + Pro exist (`OMISE_PRO_AMOUNT` satang, default 29900). **TODO:** add
> the **Business** tier + annual prices + the trial/founder/referral mechanics below.

---

## 6. Trial & growth engine
- **Free tier forever + 60-day full-Pro trial, no card required.** After 60 days → drop to **Free
  (not a hard lockout)** → upgrade when they hit a wall (LINE order, loyalty, >500 orders,
  multi-branch). Long trial fits a sticky product (menu + history = data lock-in) and is ~฿0
  marginal on shared infra.
- **Founder pricing:** first **50 shops lock ฿199/mo for life** → early adopters, reviews, cashflow.
- **Referral:** refer a shop → **both get 1 month free** → viral inside แม่ค้า/coffee FB & LINE groups.
- **Self-marketing:** the in-store **QR poster + "powered by"** on Free spreads the brand for free.

---

## 7. Legal & risk (Thailand) — close before charging
- **PDPA (2019):** we store customer name/phone/LINE id/order history → need **privacy policy +
  consent + a Data Processing Agreement** (we are the *processor*, the tenant is the *controller*).
  Already mask names in public views; add policy + export/delete on request.
- **Don't custody merchant sales funds:** merchants are paid **directly** (their PromptPay/Omise);
  we only verify slips/QR + charge our **own** subscription. This keeps us out of BOT e-money /
  payment-facilitator licensing. **Preserve this design.**
- **VAT registration** at revenue > ฿1.8M/yr (7%); quote prices **VAT-inclusive** for SMB clarity.
- **Subscription receipts / e-Tax invoice** for our billing (esp. VAT-registered customers).
- **ToS / refund / SLA / data ownership:** tenant owns + can export their data; clear cancellation
  & refund terms; limitation of liability; uptime expectation.
- **LINE Platform terms:** each tenant uses its own LINE channel and is responsible for its content/
  PDPA consent of its customers.
- **Entity:** register a company (or คณะบุคคล early) to invoice/collect and limit liability.

---

## 8. Controls / verification evidence ("SOX-style" testing)
The automated suite *is* our financial + access-control evidence; re-run on every change.

| Control | Test | Result (2026-06-21) |
|---|---|---|
| Revenue/P&L integrity | `npm run test:e2e` (gross−disc=net=Σpay=Σtender; archive snapshot) | ✅ ALL INVARIANTS HOLD |
| Tenant data isolation | `npm run test:isolation` | ✅ 15/15 (no cross-tenant leak) |
| Tenant primitives | `npm run test:tenant` | ✅ 11/11 |
| Billing logic | `SAAS=1 npm run test:billing` | ✅ 11/11 (expiry/grace, refund→downgrade) |
| Access control / RBAC | `npm run test:hierarchy` | ✅ 32/32 (roles, **global-PIN backdoor closed**, cross-tenant) |
| End-to-end journey | `npm run dryrun` (live SaaS) | ✅ 32/32 |
| **Total** | | **101 automated checks green** |
> Critical find this round: a cross-tenant `CASHIER_PIN` backdoor — found by adversarial testing,
> fixed (SaaS disables the global PIN; session-only), now permanently guarded by test:hierarchy.

---

## 9. Can we win share in the TH POS-SaaS market? — verdict
**Yes, in a focused wedge — not as a general POS.** Going head-to-head with FoodStory/StoreHub on
restaurants, or Loyverse on free POS, is a losing fight. **But** the *LINE-native queue + order +
loyalty for the smallest stalls* is a real, underserved niche we can own, then expand upward
("grows with you" into POS/stock/P&L/multi-branch). Margins are SaaS-grade (~85%); infra is cheap
and shared; the product already passes 101 controls. The risks are **execution, support, and
trust** — not the model. Win the niche, collect proof (YO-DEE + founders), expand.

---

## 10. Plan (phases)
- **Phase 0 — before charging:** always-on hosting · LINE OA support + FAQ/video · PDPA policy +
  ToS · 3 vertical templates (yogurt/coffee/food) · first-menu onboarding wizard · subscription
  receipts.
- **Phase 1 — open free, grow base:** Free tier + 60-day Pro trial (no card) + founder-50 + referral
  → gather feedback/reviews.
- **Phase 2 — monetize:** Omise live · Business tier + annual prices · cancel/renew dashboard ·
  dunning (failed-card emails before downgrade).
- **Phase 3 — expand:** delivery integration · e-Tax · optional hardware (ESC/POS printer) ·
  advanced analytics · owner mobile app.

### Build backlog (status)
- [x] Business tier + annual SKUs in `billing.js` / plans (Free/Pro/Business × month/year)
- [x] 60-day trial (auto-lapse to Free) + founder lock-in (first 50) + referral (?ref → +month both)
- [x] PDPA: data export + customer erasure endpoints + /privacy + /terms pages + owner UI
- [x] In-app dunning (expiringSoon banner ≤7d)
- [x] Path-based browser routing fix (fetch/SSE shim) + global-PIN backdoor fix
- [ ] **Email dunning** — needs an email provider (owner decision)
- [ ] **e-Tax-compliant subscription invoices** — needs a tax-invoice provider (owner decision)
- [ ] **Always-on hosting cutover** for the paid service (owner: Render Starter)
- [ ] **Live Omise verification** with the owner's test keys (card charge end-to-end)

### Verification status (controls)
`npm run` → test:e2e ✅ · test:tenant 11/11 · test:isolation 15/15 · test:billing 24/24 ·
test:hierarchy 34/34 · dryrun 32/32. (~120 automated checks.)

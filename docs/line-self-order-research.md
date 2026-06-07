# Customer Self-Ordering on LINE — Research & Decision

**Question:** Should YO-DEE Yogurt let customers order from their own phone in LINE,
get a queue number, and **pay at the counter** — and should we *build that into our own
LIFF app* or *adopt LINE MINI Eats / a LINE MINI App*?

**Date:** 2026-06-07 · **Status:** ✅ Decided — **build into our existing LIFF** (done, deployed)

---

## 1. What LINE actually offers for self-order + pay-at-counter

### LINE MINI App (the platform behind "LINE MINI Eats" / table-order)
- A **lightweight web app that runs inside LINE** — no App Store download. It is **built on
  LIFF** (the same LINE Front-end Framework our customer page already uses). A MINI App is
  essentially "a LIFF app with extra platform privileges" (permanent QR, listing in LINE's
  MINI App area, shared login/permission prompts).
- LINE's own **table-order demo**: customer **scans a QR → MINI App opens → order → checkout**,
  "complete everything from ordering to checkout with a smartphone," supports
  *multiple people ordering and paying separately*. Push updates use the **Messaging API**;
  user identity via **LINE Login/LIFF** (`display name` + `user ID`).
- **Payment:** the official demo uses the **LINE Pay** balance (online payment). The docs do
  **not** restrict you to LINE Pay — a custom MINI App can take **payment at the counter**
  instead. There is no built-in "pay later at cashier" template; you build that yourself
  (exactly what we did).

### Eligibility & certification in **Thailand** (important)
- To create a **LINE MINI App channel** with service area = Thailand you must be
  **approved by LINE**, and an organization needs a **Thai TAX ID / business registration**.
- Two tiers:
  - **Uncertified MINI App** — can be published **without** LINE's certification review.
  - **Certified MINI App** — must pass LINE's **certification review** (unlocks the nicer
    perks: appears in LINE's MINI App ecosystem, permanent QR, smoother permission UX).
- **Fees:** joining the LINE Developer Program has **no application fee**. Costs that *can*
  appear: **LINE Pay** transaction fees (only if you use online payment), **Messaging API**
  message costs above the free tier, and—commonly for small shops—**a LINE partner/agency**
  to handle the MINI App build + certification.

> Net: a MINI App is the *same LIFF technology we already use*, plus a Thai-business
> approval/certification gate and an ecosystem-listing benefit we don't need for a single stall.

**Sources:**
[LINE MINI App (TH dev portal)](https://linedevth.line.me/th/line-mini-app) ·
[LINE MINI App docs — Table Order demo](https://developers.line.biz/en/docs/line-mini-app/demo/tableorder-demo/) ·
[LINE MINI App Policy (certification tiers, TH approval)](https://terms2.line.me/LINE_MINI_App?lang=en) ·
[Handling payments — LINE MINI App](https://developers.line.biz/en/docs/line-mini-app/develop/payment/) ·
[CIPHER — LINE MINI App service overview](https://www.cipher.co.th/en/blogs/line-mini-app-sevice/) ·
[LINE Developer Partner Program (TH)](https://thlinedevpartner.landpress.line.me/home)

---

## 2. Standard architecture for "LIFF self-order → queue number → pay at counter"

This is the well-trodden pattern (and what we implemented):

1. **QR at the stall** → opens our **LIFF** page (`/liff/?zone=A`). LINE Login gives us the
   customer's `userId` + display name with **no registration**.
2. **Menu in the LIFF** — drinks with photos/icons, Thai+English+price, **topping popup** per
   drink. Customer builds a cart.
3. **Place order (no online payment)** → server creates a **ticket (queue number) + order**,
   tagged `source='customer'`, `payment_status='unpaid'`.
4. **Messaging API push** to the customer: *"Your number A0xx · Groups ahead N · 💵 pay ฿X at
   the counter."* The LIFF ticket card also shows the order + a **"Pay ฿X at counter"** badge.
5. **Cashier dashboard** shows the order with an **UNPAID** badge + a **LINE** tag; staff tap
   **Paid** when cash/PromptPay is collected (badge → **PAID ✓**), or **Cancel** to void it
   (customer is notified on LINE).
6. **Call next / served** as usual; daily report counts revenue.

No LINE Pay, no PCI scope, no payment gateway — money is handled at the counter exactly as today.

---

## 3. Recommendation — **Build into our LIFF (done)**, don't adopt LINE MINI Eats

| Factor | Build into our LIFF ✅ | Adopt LINE MINI App / MINI Eats |
|---|---|---|
| **Technology** | LIFF we already run | LIFF + MINI App wrapper (same core) |
| **Pay at counter** | Trivial — already built | Possible but you still build it yourself |
| **Thai eligibility** | None beyond our OA | **TAX ID + LINE approval**; certification review for the good tier |
| **Cost** | **฿0** beyond Render hosting | Dev/partner + possible agency for certification |
| **Queue integration** | Native — order *is* the queue ticket | Re-integrate queue into the MINI App |
| **Lock-in / control** | Full control, our DB | Tied to LINE MINI App platform & review |
| **Discovery in LINE app** | — (we share our own QR) | ✔ listed in LINE's MINI App ecosystem |

**Decision:** For a single yogurt stall, **building self-ordering into our existing LIFF is the
right call** — it reuses code we already have, needs no Thai-business certification gate, costs
nothing extra, and keeps the order tied directly to the queue number with pay-at-counter.

**Revisit a Certified MINI App later only if** YO-DEE wants to (a) be **discoverable inside the
LINE MINI App area**, (b) accept **LINE Pay online** prepayment, or (c) run a permanent
branded QR ecosystem across multiple branches. None of those apply to one stall today.

---

## 4. What we shipped (this maps the research to our build)

- **Customer (LIFF):** "Order now" → menu + topping popup → place order → queue number +
  *pay-at-counter* pill; order/payment status on the ticket card; LINE push includes the amount.
- **Cashier:** PAID/UNPAID badge + LINE tag per order; **Paid** button (collect at counter);
  **Cancel** button (void + notify customer).
- **Server:** `orders.source` / `payment_status` / `paid_at`; routes
  `POST /api/zones/:id/order` (self-order), `/tickets/:id/paid`, `/tickets/:id/void`.
- Self-orders are **deduped** (one open order per customer) to avoid duplicate numbers.

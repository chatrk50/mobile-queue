# PromptPay payment — research, POS comparison & decision

**Question:** How should YO-DEE accept **PromptPay** in the Mobile Queue app? Research the
pros/cons, compare with **Mobi-POS**, **Wongnai POS (LINE MAN Wongnai)**, and **LINE MINI Eats**,
then merge the pros and avoid the cons.

**Date:** 2026-06-08 · **Status:** ✅ Decided + **BUILT** (PromptPay dynamic QR, no gateway)

---

## 1. Ways to accept PromptPay (pros / cons)

PromptPay is Thailand's national real-time bank transfer rail. A merchant can accept it three ways:

### A. Dynamic QR via an open-source library — *no gateway* ✅ (what we built)
Generate the **EMVCo "merchant-presented" QR** for the exact order amount with a free library
(e.g. `promptpay-qr`, MIT). The customer scans with **any** Thai bank app and the amount is
pre-filled; money lands straight in the owner's bank account.
- **Pros:** **zero fees**, no contract/KYC, no settlement delay (instant, bank-to-bank), works with
  every Thai bank, ~1 day to build, no lock-in. Eliminates cash handling and wrong-amount transfers.
- **Cons:** **confirmation is manual** — the owner checks their bank app / SMS and taps "Paid"
  (no automatic webhook). The QR exposes the owner's PromptPay id (treat as semi-private). No
  automated refunds/reconciliation.

### B. PromptPay via a payment gateway (Omise/Opn, Xendit, 2C2P, GBPrimePay…)
The gateway hosts the QR and **fires a webhook** when paid, so the order auto-marks paid.
- **Pros:** automatic confirmation + reconciliation, multi-method (cards/wallets), refunds.
- **Cons:** **per-transaction fee** (PromptPay ≈ **Omise 1.65%**, **Xendit ~0.8%**), merchant
  onboarding/KYC, T+1 settlement, integration + lock-in. Overkill for a single stall's volume.

### C. Direct bank API (SCB, KBank, BBL…)
Full in-house QR + webhook + status/refund.
- **Pros:** automated, up to ~THB 2M/txn. **Cons:** requires a bank merchant account + heavier
  integration; built for higher volume.

**Sources:**
[Fiuu — Accept PromptPay: merchant guide](https://fiuu.com/blog/detail/accept-promptpay-in-thailand-a-merchants-guide-to-qr-payments) ·
[Antom — Guide to PromptPay](https://knowledge.antom.com/guide-to-promptpay-in-thailand) ·
[`promptpay-qr` (MIT, npm)](https://github.com/dtinth/promptpay-qr) ·
[Omise PromptPay docs](https://docs.omise.co/promptpay) · [Omise pricing TH](https://www.omise.co/en/pricing/thailand) ·
[Xendit QR PromptPay](https://www.xendit.co/en/payment-channel/qr-promptpay/)

---

## 2. Comparison with the named POS systems

| | **Our LIFF app** (built) | **Mobi-POS** | **Wongnai POS** (LINE MAN Wongnai) | **LINE MINI Eats** |
|---|---|---|---|---|
| Type | LINE LIFF web app (ours) | iPad POS, offline-first | Cloud POS ecosystem | LINE MINI App |
| PromptPay | **Dynamic QR, no fee** (library) | Not native (card-reader integrations: Square/SumUp/Zettle…) | **QR PromptPay, no txn fee** (POS Pay); customer self-order+pay (Order & Pay) | LINE Pay / online pay |
| Self-order by customer | ✅ in LINE, our menu | ✖ (staff/terminal) | ✅ "Order & Pay" add-on | ✅ in LINE |
| Queue integration | ✅ native (order = queue #) | ✖ | partial | ✖ |
| Cost | **฿0** beyond Render | iPad + paid modules (free lite = 30 items/10 txn/day) | ~฿10–20/day + POS HW from **฿8,900** | dev/partner + **Thai TAX-ID + LINE certification** |
| Lock-in | none (our code) | app/vendor | Wongnai/FoodStory ecosystem | LINE platform |

Key reads:
- **Wongnai POS Pay** also settles PromptPay with **no transaction fee** and auto-closes the bill /
  guards against fake receipts — i.e. the same "PromptPay QR, no fee" model we chose, **validating
  the approach**; the difference is it's a **paid ecosystem + hardware**, while ours is free and
  already wired to our queue.
- **Mobi-POS** is a powerful **restaurant** POS (tables, KDS, inventory) — overkill for a stall, has
  no native Thai PromptPay, and doesn't talk to our LINE queue.
- **LINE MINI Eats** needs a **TAX-ID + LINE certification** and leans on online LINE Pay (see
  `docs/line-self-order-research.md`); worth it only for in-LINE discovery / online prepay.

**Sources:**
[Wongnai POS Pay (QR PromptPay, no fee)](https://www.wongnai.com/pos-articles/wongnai-pos-pay) ·
[Wongnai Order & Pay](https://www.wongnai.com/pos-articles/wongnaipos-order-pay) ·
[MobiPOS site](https://www.mobi-pos.com/) · [MobiPOS pricing](https://www.mobi-pos.com/web/pricing) ·
[LINE MINI Eats](https://lineforbusiness.com/th/service/lineminieats)

---

## 3. Decision — merge the pros, avoid the cons → **PromptPay dynamic QR, no gateway** (BUILT)

For a single yogurt stall the winning combination is the **free dynamic-QR** path (option A),
which captures the pros the paid systems sell (instant cashless, exact amount, no fake-receipt
disputes, no cash to count — same as Wongnai POS Pay) **without** their cons (no monthly fee, no
฿8,900 hardware, no gateway %, no KYC, no certification, no lock-in).

The single unavoidable con of option A — **no automatic paid-confirmation** — is acceptable because
the owner is already at the counter doing pay-at-counter; they glance at their bank app/SMS and tap
**Paid** (which we already have). **Upgrade path:** if volume later makes manual checking a chore,
swap in a gateway webhook (**Xendit ~0.8%** or **Omise 1.65%**) to auto-mark paid — a config change,
no rework, because the customer QR + order flow stay identical.

### What we shipped
- `promptpay-qr` generates the EMV payload → rendered as a PNG by `/api/promptpay-qr?amount=X`.
- Gated by env **`PROMPTPAY_ID`** (owner's phone / national-id / e-wallet). Off if unset.
- **Customer (LIFF):** on the ticket, a **"Pay by PromptPay"** button reveals a QR for the order
  total — scan, pay, done; "or pay cash at counter" still works.
- **Cashier:** a **📱 QR** button on any unpaid order shows the same QR for walk-ins; staff confirm
  in their bank app and tap **Paid**.
- **To enable:** set `PROMPTPAY_ID` in the Render dashboard (e.g. the shop's PromptPay phone number).

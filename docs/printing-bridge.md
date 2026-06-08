# Receipt & kitchen printing — design (honest, hardware-dependent)

> Status: **design only**. Printing needs a physical printer to build + test, so nothing
> is wired into the app yet. This doc is the plan + what the owner must buy/set up.

## The constraint (no magic)
Our stack is a **web app on Render** opened in **iPad Safari**. Two hard limits:
1. **iPad Safari cannot drive USB or Bluetooth printers.** Web Bluetooth / WebUSB are
   *not supported* on iOS Safari (they exist only on Chrome desktop/Android). So the
   "browser talks to a BT printer" approach is **out** for an iPad-first till.
2. **The Render server is in the cloud, the printer is on the shop's LAN** (behind the
   shop router/NAT). The cloud server cannot reach `192.168.x.x` directly. So either the
   *browser* (same LAN as the printer) talks to it, or an *on-prem relay* bridges cloud→LAN.

## Options
| # | Approach | Works on iPad? | Internet needed to print? | Cost | Notes |
|---|---|---|---|---|---|
| A | **LAN ESC/POS printer w/ built-in ePOS server** (Epson TM‑m30II), browser → printer LAN IP via **Epson ePOS‑Print JS SDK** | ✅ yes | ❌ no (LAN only) | printer only (~3–5k THB) | **Recommended.** No cloud, no subscription, prints even if internet drops. |
| B | **Cloud print service** (PrintNode / Epson Connect): server → service API → printer | ✅ (server-driven) | ✅ yes | monthly sub + printer | Works through NAT, but needs internet + recurring cost. |
| C | **On‑prem relay** (Raspberry Pi / mini‑PC on shop LAN) polls cloud for jobs → prints to LAN printer over TCP :9100 | ✅ | ✅ to fetch jobs | printer + ~Pi (~1–2k THB) | Most flexible for many devices / central queue; more to maintain. |
| D | Browser Web Bluetooth / WebUSB to a BT printer | ❌ **not on iOS Safari** | ❌ | cheap BT printer | Only viable if the till were Android/desktop Chrome. Rejected for iPad. |

## Recommendation
**Option A — Epson TM‑m30II (or Star mC‑Print3) LAN/Wi‑Fi printer + Epson ePOS‑Print
JavaScript from the cashier page to the printer's LAN IP.**
- The iPad and printer share the shop Wi‑Fi. The cashier page loads the ePOS‑Print SDK
  and POSTs an ESC/POS job to `http(s)://<printer-lan-ip>/cgi-bin/epos/service.cgi`.
- **Prints even if the internet is down** (it's LAN‑local) — important for a till.
- No subscription, no extra server, no NAT problem.
- If the shop later runs several tills or wants a central kitchen queue, add Option C
  (a Pi relay) without changing the receipt format.

## What the owner buys / sets up
1. An **Epson TM‑m30II** receipt printer (LAN or Wi‑Fi model) — thermal 80mm. (~3,000–5,000 THB.)
2. Connect it to the **shop Wi‑Fi**; note its **LAN IP** (e.g. 192.168.1.50) — set a DHCP
   reservation so it doesn't change.
3. (Kitchen tickets) either a **second printer** in the kitchen, or print the kitchen
   ticket to the same printer.
4. Enable the printer's **ePOS‑Print / Server Direct Print** in its web config.

## Phased build plan (when the printer is on hand)
- **Config:** store `printerIp` (+ optional `kitchenPrinterIp`) in settings (owner screen).
  When unset, printing UI stays hidden (current behavior).
- **Phase A — Receipt:** a `receipt(order)` model → render to the ePOS‑Print SDK builder
  (shop name/logo, date, queue code, line items + toppings, discount, total, payment
  method, PromptPay QR, "thank you"). A **"พิมพ์ใบเสร็จ"** button on a paid order calls the
  SDK against `printerIp`. Optionally auto-print on payment (setting).
- **Phase B — Kitchen ticket:** on *Send Order*, print an items-only ticket (large font,
  no prices) to `kitchenPrinterIp`. Group by drink + toppings + sweetness.
- **Reprint:** from Order History / transaction log.
- **Fallback:** keep the existing on-screen / "Print Current Bill" (browser print) path
  for shops without a thermal printer.

## Testing reality
This integration **cannot be verified without the physical printer** (the ePOS endpoint
is on the printer). So it ships as: config + UI + the ESC/POS job builder (unit-testable
for byte output), and the owner does a one-time on-site print test. Until a `printerIp`
is set, nothing changes for the current shop.

## Why not just "print from the browser" (Cmd/Ctrl‑P)?
Browser print → the OS print dialog → works only with an AirPrint/driver printer and
produces an A4-ish page, not a clean 80mm thermal receipt with a cut. Fine as a fallback,
not as the primary receipt path. ePOS‑Print gives proper thermal formatting + auto-cut +
cash-drawer kick.

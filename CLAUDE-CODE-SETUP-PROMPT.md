# Prompt for Claude Code — Mobile Queue guided setup

> **How to use:** open Claude Code inside the `mobile-queue` folder and paste
> everything below the line into the chat. It tells Claude Code to walk you
> through setup **one step at a time, pausing for your reply between steps.**

---

You are helping me set up and run a project called **Mobile Queue** on my machine.
Work through the setup **step by step**. After each step:
1. Run or show exactly what I need to do.
2. **STOP and wait for my reply** (e.g. I paste the command output, an error, or say "ok / done / next").
3. Only continue once I respond. If I paste an error, fix it before moving on.
Do not run multiple setup steps in one go. Keep each step small and verify it
worked before advancing. Ask me for any value you can't find yourself (LINE
tokens, my domain, the PIN I want). Confirm my OS first (Windows / macOS / Linux)
because some commands differ.

## Key takeaways about this project (keep these in mind the whole time)

**What it is:** a scan-and-queue system with LINE notifications — a simplified
clone of the DeltaQueue restaurant flow. Customer journey, deliberately minimal:
*scan an offline QR at the storefront → LIFF opens inside LINE and identifies the
guest automatically (no app install, no registration) → guest picks party size
and gets a queue number → LINE pushes a confirmation, a "you're up soon" warning,
and a "your turn" message.* Staff drive it from a cashier screen; a TV display
shows now-serving / next with a Thai voice call-out. Multi-zone, prefixed tickets
(A001, B001…).

**Stack & deliberate design decisions:**
- **Node.js 22.5+** required. Storage is Node's **built-in `node:sqlite`** — chosen
  on purpose instead of `better-sqlite3` so there is **no native build step** and
  it runs anywhere Node 22+ runs. The npm scripts pass `--experimental-sqlite`;
  the one "experimental feature" warning is expected and harmless.
- **Express** REST API + **Server-Sent Events** (in-memory) for live cashier/display updates.
- **@line/bot-sdk** for LINE Messaging API push + webhook; **LIFF** for the
  registration-free customer identification; **qrcode** to generate printable QRs.
- Frontends are plain HTML/CSS/JS — **no build tooling**.
- **LINE degrades gracefully:** with no LINE keys in `.env`, push messages print
  to the server console instead of sending — so the whole flow is testable before
  any LINE account exists. This is the recommended way to first verify it.
- **PIN auth is intentionally light** (fine for an in-store tablet, not a public
  admin panel). SQLite + in-memory SSE suits a single node (one shop / small chain).
- WAL is attempted but falls back to the default journal if the filesystem
  rejects it (handled in `server/db.js`).

**File layout:**
```
server/   index.js (routes+SSE) · queue.js (logic) · line.js · db.js · events.js
public/   liff/ (customer) · cashier/ · display/ · assets/ (css, qr/)
scripts/  seed.js · gen-qr.js · test-flow.js
README.md · คู่มือการใช้งาน.md (Thai manual) · .env.example
```

**Notification rule (threshold = NOTIFY_THRESHOLD, default 2):** after every
call/serve/skip, any waiting guest now within `threshold` groups of the front who
hasn't been warned yet gets a **one-time** "soon" push. Verified by `npm test`.

## The setup sequence to guide me through (one step per message, pausing each time)

**Phase A — Local run with LINE stubbed (no accounts needed yet):**
- **Step 1.** Confirm my OS, then check `node -v` is ≥ 22.5.0 (and `npm -v`). If Node is older or missing, help me install/upgrade it. → pause.
- **Step 2.** Run `npm install`. → pause for output.
- **Step 3.** Create `.env` from `.env.example` (Windows `copy`, macOS/Linux `cp`). Briefly explain each variable; defaults are fine for local. → pause.
- **Step 4.** Run `npm run seed` (creates the demo store + 3 zones). → pause.
- **Step 5.** Run `npm run qr` (writes QRs to `public/assets/qr/`). → pause.
- **Step 6.** Run `npm start`, then have me open `/cashier/` (PIN `1234`), `/display/`, and `/liff/?zone=1`. Tell me to press **Call next** and confirm the display + customer pages update live, and that the simulated LINE messages appear in the server console. → pause until I confirm it works.
- **Step 7.** Run `npm test` and confirm all logic checks pass. → pause.

**Phase B — Enable real LINE (only after Phase A works, and only if I want to go live):**
- **Step 8.** Guide me to create a LINE **Messaging API channel** in the [LINE Developers Console](https://developers.line.biz/console/); collect the **Channel access token (long-lived)** and **Channel secret**. → pause for me to paste/confirm I have them.
- **Step 9.** Guide me to create a **LIFF app** (Endpoint URL `https://MY_DOMAIN/liff/`, Size Full, scopes `profile` + `openid`); collect the **LIFF ID**. → pause.
- **Step 10.** Help me fill `.env`: `PUBLIC_BASE_URL`, `CASHIER_PIN`, `NOTIFY_THRESHOLD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LIFF_ID`. → pause.
- **Step 11.** Set the channel **Webhook URL** to `https://MY_DOMAIN/line/webhook` and turn webhook on. If I'm testing locally, help me start a tunnel (`ngrok http 3000` or `cloudflared`) and use that HTTPS URL. Remember LINE requires HTTPS for both webhook and LIFF. → pause.
- **Step 12.** Re-run `npm run qr` so the QRs now point at the LIFF URL; have me print `public/assets/qr/zone-<id>.png` and place each at the matching zone. → pause.
- **Step 13.** Restart the server, confirm the console says `LINE: ENABLED`, and do one real end-to-end test (scan with my own phone → receive the LINE messages). → pause.

**Phase C — Customize for the real shop (optional):**
- **Step 14.** Help me edit `scripts/seed.js` to set the real store name, zones, and ticket prefixes; then delete `data/queue.db` and re-run `npm run seed`. → pause.
- **Step 15.** Remind me to back up `data/queue.db`, and that the cashier/display screens should sit behind the shop's own network/auth (PIN is light).

At the end, give me a short recap of what's running, the URLs, and the one or two
things I still need to do myself (e.g. print and place the QR codes, secure the
cashier screen).

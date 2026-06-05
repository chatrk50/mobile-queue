# Mobile Queue — Config Reference

Live: **https://mobile-queue.onrender.com** · Brand **YO-DEE Yogurt** · Branch **SAT Market** · Zones **A, B** · UI **English only**

## Screens
| Screen | URL | Notes |
|---|---|---|
| Home (hub) | `/` | links to the screens below |
| Cashier | `/cashier/` | PIN login; all zones; Back/Logout |
| Display (TV) | `/display/` | now-serving + English voice call-out |
| Customer (LIFF) | `https://liff.line.me/2010308807-nrzjBCPa?zone=<id>` | opens in LINE |
| Print poster | `/print/?zone=<id>` | A5 poster w/ logo + QR |
| QR image | `/api/qr/<zoneId>` | PNG of the LIFF URL |

## Hosting (Render, free plan)
- Service `mobile-queue`, region **Singapore**, repo **chatrk50/mobile-queue** (branch `main`), auto-deploy on push.
- Start: `npm run seed && npm start` (re-seeds each boot — free disk is ephemeral, so the queue also resets on every cold start).
- Config is in `render.yaml` (non-secret) + Render **Environment** dashboard (secrets, `sync:false`).

## Environment variables
| Key | Value / where | Purpose |
|---|---|---|
| `NODE_VERSION` | `22.17.0` (render.yaml) | needs ≥22.5 for `node:sqlite` |
| `PUBLIC_BASE_URL` | `https://mobile-queue.onrender.com` (render.yaml) | base URL for links/QRs |
| `NOTIFY_THRESHOLD` | `2` (render.yaml) | LINE "soon" alert when ≤N groups ahead |
| `WAIT_PER_GROUP_MIN` | `4` (render.yaml) | est. minutes per group (customer ETA) |
| `LIFF_ID` | `2010308807-nrzjBCPa` (render.yaml) | customer LIFF |
| `LINE_ADD_FRIEND_URL` | `https://line.me/R/ti/p/@138dccus` (render.yaml) | "Add friend" button target |
| `CASHIER_PIN` | **Render dashboard** (secret) | staff login PIN — change here anytime |
| `LINE_CHANNEL_ACCESS_TOKEN` | **Render dashboard** (secret) | Messaging API push token |
| `LINE_CHANNEL_SECRET` | **Render dashboard** (secret) | webhook signature |

## LINE (provider: YO-DEE Yogurt)
- Official Account: **@138dccus** (add-friend required before getting a number).
- Messaging API channel ID: **2010308718** — token + secret + webhook live here.
- LINE Login channel ID: **2010308807** — LIFF lives here; **linked to the OA** (enables friend-check).
- LIFF: ID `2010308807-nrzjBCPa`, endpoint `/liff/`, size **Full**, scopes **profile + openid**.
- Webhook: `https://mobile-queue.onrender.com/line/webhook` (verified).

## Behaviour
- **One number per scan** (no party size).
- **Add-friend required**: LIFF checks `liff.getFriendship()`; non-friends see an "Add LINE friend" screen.
- **Notifications** (auto, server-side): confirmation, "you're up soon" (≤2 ahead), "your turn" — each a LINE card with a **Check my queue** button (hidden URL). Resume by LINE ID after closing the app.
- **One active number per customer** — re-scanning returns the same number (no duplicates).
- **Estimated wait** shown to customers = `groups ahead × WAIT_PER_GROUP_MIN` (4 min).
- **No-show** — cashier "No-show" button on called tickets (`POST /api/tickets/:id/noshow`, PIN); counted in the report.
- **Rating** — after a ticket is **served**, the customer LIFF shows ⭐×5 → `POST /api/tickets/:id/rate {stars}`; average shown in the report.
- **Daily report** — cashier "📊 Report" button / `GET /api/report` (PIN): cups sold, no-shows, avg wait, avg rating + per-zone, since the last reset. (Week/month history needs a persistent disk — see ROADMAP.md.)
- **Daily reset** to A001 at **00:00 Asia/Bangkok** (in-process). Manual/cron: `POST /api/reset` with header `x-cashier-pin`.

## Customise
- Store / branch / zones / prefixes: `scripts/seed.js` → delete `data/queue.db` → `npm run seed` (or redeploy).
- Colours/logo: `public/assets/styles.css` + `public/assets/logo.png`.
- Add a branch: add another store + zones in `scripts/seed.js`.

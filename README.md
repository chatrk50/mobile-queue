# Mobile Queue 🎫

A scan-and-queue system with LINE notifications — a simplified clone of the
DeltaQueue restaurant flow. The customer journey is stripped down to the minimum:

> **Scan an offline QR at the storefront → get your queue number on LINE →
> get a LINE push when you're up soon → another when it's your turn.**

No customer app install, **no registration** — the LINE login inside the QR
(LIFF) identifies the customer automatically.

## What's included

| Screen | URL | Who uses it |
|---|---|---|
| **Customer** | `/liff/?zone=<id>` | Guests (opened by scanning the QR) |
| **Cashier** | `/cashier/` | Staff — call next, serve, skip, open/close zones |
| **Display** | `/display/` | TV in the shop — shows now-serving + next, with voice call-out |
| Landing | `/` | Links to all of the above |

Core features cloned from DeltaQueue: multi-zone queues, per-zone ticket
prefixes (A001, B001…), call-next with status (called/served/skipped),
open/close a zone, public display with Thai voice announcement, and **LINE
notifications** — confirmation, "coming up soon", and "your turn".

## Tech

- **Node.js 22+** (uses the built-in `node:sqlite` — *no native build step*)
- **Express** REST API + **Server-Sent Events** for live cashier/display updates
- **@line/bot-sdk** for LINE Messaging API push + webhook
- **LIFF** (LINE Front-end Framework) for the registration-free customer flow
- **qrcode** to generate the printable offline QR codes
- Plain HTML/CSS/JS frontends — no build tooling

> Runs **fully locally with LINE stubbed**: if no LINE keys are set, push
> messages are printed to the server console instead of sent, so you can test
> the entire flow before touching a LINE account.

---

## Quick start (local, LINE stubbed)

```bash
npm install
cp .env.example .env        # defaults are fine for local
npm run seed                # creates a demo store with 3 zones
npm run qr                  # writes printable QRs to public/assets/qr/
npm start                   # http://localhost:3000
```

Then open:
- `http://localhost:3000/cashier/` (PIN `1234`)
- `http://localhost:3000/display/`
- `http://localhost:3000/liff/?zone=1` (acts as a customer; "soon"/"turn"
  messages appear in the **server console** while LINE is stubbed)

Press **Call next** in the cashier screen and watch the display + customer
pages update live.

> **Node version:** requires Node **22.5+** (for `node:sqlite`). The npm scripts
> pass `--experimental-sqlite`; you'll see one "experimental feature" warning —
> that's expected and harmless.

---

## Going live with real LINE notifications

You need a **LINE Official Account** + a **Messaging API channel** + a **LIFF app**.
All free to create.

### 1. Create the LINE Official Account & Messaging API channel
1. Go to the [LINE Developers Console](https://developers.line.biz/console/).
2. Create a **Provider**, then a **Messaging API channel** (this also creates an
   Official Account).
3. In the channel's **Messaging API** tab:
   - Issue a **Channel access token (long-lived)** → set as `LINE_CHANNEL_ACCESS_TOKEN`.
   - Copy the **Channel secret** (Basic settings tab) → set as `LINE_CHANNEL_SECRET`.
   - Turn **Use webhook** ON and set the **Webhook URL** to
     `https://YOUR_PUBLIC_DOMAIN/line/webhook`.
   - Disable "Auto-reply messages" / "Greeting messages" if you want only your
     own replies.

### 2. Create the LIFF app (registration-free customer flow)
1. In the same channel, open the **LIFF** tab → **Add**.
2. Settings:
   - **Endpoint URL**: `https://YOUR_PUBLIC_DOMAIN/liff/`
   - **Size**: Full
   - **Scopes**: `profile`, `openid`
3. Copy the **LIFF ID** → set as `LIFF_ID`.

> The customer page calls `liff.getProfile()` to read the LINE `userId`. That id
> is what we push notifications to — **no phone number, no sign-up form.**

### 3. Configure `.env`
```ini
PORT=3000
PUBLIC_BASE_URL=https://YOUR_PUBLIC_DOMAIN
CASHIER_PIN=choose-a-pin
NOTIFY_THRESHOLD=2            # notify when this many groups remain ahead
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LIFF_ID=...
```

### 4. Regenerate the QR codes to point at LIFF
```bash
npm run qr
```
With `LIFF_ID` set, each QR now encodes `https://liff.line.me/<LIFF_ID>?zone=<id>`,
so scanning opens the flow **inside LINE** and the guest is identified
automatically. Print `public/assets/qr/zone-<id>.png` and stick each one at the
matching zone/counter.

### 5. Deploy
Host on anything that runs Node 22+ and is reachable over HTTPS (Railway,
Render, Fly.io, a VPS behind Caddy/Nginx, etc.). LINE requires **HTTPS** for both
the webhook and the LIFF endpoint. For local testing against real LINE, expose
your machine with a tunnel (e.g. `cloudflared tunnel` or `ngrok http 3000`) and
use that HTTPS URL as `PUBLIC_BASE_URL` / webhook / LIFF endpoint.

---

## How the queue logic works

- Each **zone** keeps its own running counter and prefix → tickets like `A001`.
- **Issue**: customer scans → picks party size → `POST /api/zones/:id/tickets`
  with their LINE `userId`. They get a confirmation push.
- **Call next**: cashier calls the lowest waiting number. That guest gets a
  "your turn" push.
- **Coming up soon**: after every call/serve/skip the server recomputes each
  waiting guest's position; anyone now within `NOTIFY_THRESHOLD` groups of the
  front who hasn't been warned yet gets a **one-time** "you're up soon" push.
- All cashier/display screens update instantly via SSE.

### Notification timeline (threshold = 2)
```
Queue: A001 A002 A003 A004 A005
Call A001  ->  A002,A003,A004 get "soon"   (A005 is 3 ahead: not yet)
Call A002  ->  A005 now 2 ahead -> gets "soon"
```
(Exactly this is asserted in `npm test`.)

## API reference (short)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | – | LIFF id, threshold, LINE on/off |
| GET | `/api/stores` · `/api/stores/:id/zones` | – | list stores / zones |
| GET | `/api/zones/:id` · `/api/zones/:id/snapshot` | – | zone + live queue |
| POST | `/api/zones/:id/tickets` | – | issue a ticket `{partySize, lineUserId}` |
| GET | `/api/tickets/:id` | – | customer polls own status |
| POST | `/api/tickets/:id/cancel` | – | customer cancels |
| POST | `/api/zones/:id/call-next` | PIN | call next number |
| POST | `/api/tickets/:id/serve` · `/skip` | PIN | close out a ticket |
| POST | `/api/zones/:id/open` | PIN | open/close a zone `{isOpen}` |
| GET | `/api/zones/:id/stream` | – | SSE live updates |
| POST | `/line/webhook` | LINE sig | follow/greeting events |

PIN is sent via the `x-cashier-pin` header (the cashier page does this for you).

## Tests
```bash
npm test     # verifies numbering, ahead-count, call ordering, soon-threshold, closed-zone guard
```

## Notes, limits & honest caveats
- **PIN auth is intentionally light** — fine for an in-store tablet, not a
  public admin panel. Put the cashier/display behind your own network/auth for
  production, and consider per-staff accounts if you need an audit trail.
- **SQLite + in-memory SSE** suits a single-node deployment (one shop or a small
  chain). For many simultaneous branches at scale, move to Postgres and a shared
  pub/sub (e.g. Redis) — the `db.js` and `events.js` modules are the only files
  that would change.
- The Thai voice on the display uses the browser's built-in speech synthesis;
  available Thai voices vary by OS/browser. Click **🔊 เปิดเสียง** once to enable
  audio (browsers block autoplay until a user gesture).
- This is an independent re-implementation of the *flow*, not DeltaQueue's code
  or assets.

## Project layout
```
server/   index.js (routes+SSE) · queue.js (logic) · line.js · db.js · events.js
public/   liff/ (customer) · cashier/ · display/ · assets/ (css, qr/)
scripts/  seed.js · gen-qr.js · test-flow.js
```

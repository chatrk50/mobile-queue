# Durable storage (keep sales history across restarts) — Turso / libSQL

By default the app stores data in a local SQLite file. On **Render's free tier the
disk is wiped on every restart, redeploy, and 15‑minute idle spin‑down**, so the
daily/monthly sales history (and menu edits, order history, etc.) only survive
until the next restart.

To make data **permanent**, the app can use **Turso** — a free, SQLite‑compatible
cloud database — through a *libSQL embedded replica*: the app keeps a fast local
copy, every write is forwarded to the Turso cloud, and on boot it pulls the cloud
copy back. No code changes, no schema changes; it turns on automatically when two
environment variables are present.

> The app already ships with the `libsql` driver and the dual‑backend logic
> (`server/db.js`). You only need to create the free database and paste two values
> into Render. **You must do the account/token steps yourself** — I can't create
> accounts or handle your secret token.

## One‑time setup (~5 minutes)

### 1. Create a free Turso database
- Sign up at **https://turso.tech** (free tier: 500 DBs, 9 GB, plenty for a shop).
- Install the CLI and log in (or use the web dashboard "Create Database"):
  ```bash
  # macOS/Linux
  curl -sSfL https://get.tur.so/install.sh | bash
  turso auth login
  turso db create mobile-queue
  ```
- Get the database URL (looks like `libsql://mobile-queue-<you>.turso.io`):
  ```bash
  turso db show mobile-queue --url
  ```
- Create an auth token:
  ```bash
  turso db tokens create mobile-queue
  ```

### 2. Put the two values into Render
In the Render dashboard → service **mobile-queue** → **Environment**:
| Key | Value |
|-----|-------|
| `TURSO_DATABASE_URL` | the `libsql://…turso.io` URL from step 1 |
| `TURSO_AUTH_TOKEN`   | the token string from step 1 (secret) |

Save → Render redeploys. On boot the log shows **`[db] Durable mode ON — Turso/libSQL embedded replica`** (instead of `Local mode`).

### 3. Done
- The first boot seeds the menu into Turso (idempotent — it won't re‑seed after that).
- From now on, sales history and all data persist across restarts/redeploys.
- To inspect the data anytime: `turso db shell mobile-queue` then `SELECT * FROM sales_history;`

## Turning it off
Remove both env vars → the app falls back to local `node:sqlite` (ephemeral). Nothing else changes.

## Notes
- Writes are debounced and synced to the cloud within ~1s; a periodic safety sync
  runs every 60s and a final flush runs on shutdown (`server/db.js`).
- Keep `TURSO_AUTH_TOKEN` secret — it's `sync: false` in `render.yaml`, never in git.
- Alternative durable options if you ever prefer them: **Fly.io** + a persistent
  volume (move hosting, ~$2/mo for a tiny volume), or **Neon** Postgres (would need
  a SQL‑dialect port). Turso is recommended because it's free and SQLite‑compatible.

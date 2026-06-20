# Deploying the SaaS (go-live checklist)

The SaaS runs as its **own** Render service from the **`saas` branch** with a **dedicated Turso
DB**. The single-shop deployment (YO-DEE, `main`) is never touched.

> What I (Claude) can't do for you: create the Render service / Turso DB or point DNS — those
> need your accounts and a few dashboard clicks. Everything else (code, blueprint, env list) is
> ready. Follow the steps; it's ~15 minutes.

## 1. Create the database (Turso)
1. Sign in at [turso.tech](https://turso.tech) → create a DB (e.g. `mobile-queue-saas`), region
   closest to you.
2. Copy the **database URL** (`libsql://…`) and create an **auth token**. Keep both.

## 2. Create the Render service (Blueprint)
1. Render Dashboard → **New → Blueprint** → connect this repo → choose **`render-saas.yaml`**.
   It provisions a `web` service `mobile-queue-saas` on the **`saas`** branch.
2. When prompted, fill the `sync:false` env vars:
   - `SAAS_ADMIN_PIN` — long random string (your platform-admin console password)
   - `SESSION_SECRET` — long random string
   - `PUBLIC_BASE_URL` — your service URL, e.g. `https://mobile-queue-saas.onrender.com`
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — from step 1
3. Deploy. Health check hits `/signup/`.

## 3. Smoke test (or run the automated dry run)
- Open `PUBLIC_BASE_URL/signup` → register a test brand → confirm it lands on
  `/b/<slug>/cashier/` and logs in with the PIN you chose.
- Open `PUBLIC_BASE_URL/admin` → enter `SAAS_ADMIN_PIN` → you should see the test brand.
- Automated: `BASE=<PUBLIC_BASE_URL> SAAS_ADMIN_PIN=<pin> npm run dryrun` (32 checks).

## 4. (Optional) Custom domains for brands
For a brand that wants `shop.theirbrand.com`:
1. The **brand owner** points DNS: a `CNAME` from `shop.theirbrand.com` → your Render host.
2. In **Render → the service → Settings → Custom Domains**, add `shop.theirbrand.com` (Render
   issues the TLS cert).
3. In **/admin**, click **โดเมน** on that brand and enter `shop.theirbrand.com`.
   → the brand now serves at the root of its own domain (no `/b/<slug>/`).

## 5. Plans & billing
- New brands default to **free** (1 branch, 500 orders/month). **pro** = unlimited.

**Option A — manual:** leave Omise env blank. Upgrade a brand to pro from **/admin** (plan
dropdown). Collect payment out-of-band.

**Option B — self-service (Omise, monthly subscription):** set `OMISE_SECRET_KEY` +
`OMISE_PUBLIC_KEY` (+ optional `OMISE_PRO_AMOUNT` in satang, `OMISE_CURRENCY`) from
[dashboard.omise.co](https://dashboard.omise.co). Then:
- A brand owner opens ⚙ ตั้งค่าระบบ → **💳 แพ็กเกจการใช้งาน → อัปเกรด Pro** → pays by card in the
  Omise popup (card data goes straight to Omise — never our server) → instantly Pro for 1 month.
- The server saves the card on an Omise customer and **auto-renews monthly** (a 6-hourly sweep
  charges due tenants; lapses to free after a 3-day grace if a charge fails). Owners can cancel
  auto-renew anytime (Pro stays until the paid-through date).
- Point your Omise **webhook** at `PUBLIC_BASE_URL/billing/omise/webhook` (used to downgrade on
  refunds; events are re-verified against the Omise API).
- Test first with Omise **test keys** (`skey_test_…` / `pkey_test_…`) + a test card before going
  live. Quota enforcement (`branch_limit` / `order_limit`) is already in place.

## Operating notes
- **Free plan spins down** after 15 min idle (cold start ~30s). Switch the service to `starter`
  (or add an uptime ping) once brands depend on it.
- **Backups:** Turso has its own backups; you can also adapt `scripts/backup-dump.js`.
- **Isolation** is enforced + tested (`npm run test:isolation`, `npm run dryrun`). Each brand's
  data, staff PINs, settings, loyalty, brand theme and LINE channel are fully separate.
- The `saas` branch is the SaaS code line; `main` stays the single-shop (YO-DEE) line. Merge
  `main`→`saas` to bring shop features into the SaaS; keep them separate to protect the live shop.

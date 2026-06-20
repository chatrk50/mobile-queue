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
- New brands default to **free** (1 branch, 500 orders/month). Upgrade a brand to **pro**
  (unlimited) from **/admin** (plan dropdown). This is **manual billing** — collect payment
  out-of-band for now.
- To automate payment later, wire a provider (e.g. Stripe Checkout) to call
  `setTenantPlan(tenantId, 'pro')` on success and downgrade on cancellation. The quota
  enforcement (`branch_limit` / `order_limit`) is already in place.

## Operating notes
- **Free plan spins down** after 15 min idle (cold start ~30s). Switch the service to `starter`
  (or add an uptime ping) once brands depend on it.
- **Backups:** Turso has its own backups; you can also adapt `scripts/backup-dump.js`.
- **Isolation** is enforced + tested (`npm run test:isolation`, `npm run dryrun`). Each brand's
  data, staff PINs, settings, loyalty, brand theme and LINE channel are fully separate.
- The `saas` branch is the SaaS code line; `main` stays the single-shop (YO-DEE) line. Merge
  `main`→`saas` to bring shop features into the SaaS; keep them separate to protect the live shop.

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
   - `SESSION_SECRET` — long random string (app refuses to boot in SaaS without ≥16 chars)
   - `PUBLIC_BASE_URL` — your service URL, e.g. `https://mobile-queue-saas.onrender.com`
   - `BASE_URL` — usually the same as `PUBLIC_BASE_URL` (used in email links)
   - `SAAS_BASE` — your platform apex, e.g. `khai-dee.com` (reserves platform hostnames so no
     brand can claim them — see Security note below)
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — from step 1
   - **Recommended:** `SENDGRID_API_KEY` + `EMAIL_FROM` — without these, all transactional/billing
     emails (welcome, receipts, dunning, password reset, activation nudges) only dry-run to the log.
   - **Optional:** `PLATFORM_ADMIN_EMAIL` — get an email on every new brand signup.
   - **Leave `TRUST_PROXY_HOPS` at its default (1).** Render is a single proxy hop. Only set it to
     `2` if you put a CDN (e.g. Cloudflare) in front. (See Security note.)
3. Deploy. Health check hits `/signup/`.

## 3. Smoke test (or run the automated dry run)
- Open `PUBLIC_BASE_URL/signup` → register a test brand → confirm it lands on
  `/b/<slug>/cashier/` and logs in with the PIN you chose.
- Open `PUBLIC_BASE_URL/admin` → enter `SAAS_ADMIN_PIN` → you should see the test brand.
- Automated: `BASE=<PUBLIC_BASE_URL> SAAS_ADMIN_PIN=<pin> npm run dryrun` (32 checks).

## 4. (Optional) Custom domains for brands  — **Business plan**
For a Business-plan brand that wants `shop.theirbrand.com`:
1. The **brand owner** points DNS: a `CNAME` from `shop.theirbrand.com` → your Render host.
2. In **Render → the service → Settings → Custom Domains**, add `shop.theirbrand.com` (Render
   issues the TLS cert).
3. Set the mapping — either path works:
   - **Self-service (Business owners):** ⚙ ตั้งค่า → **แพ็กเกจ** → enter the domain (gated to
     Business; Free/Pro get `plan_required`). The panel shows the CNAME instructions.
   - **Admin:** in **/admin**, click **โดเมน** on that brand and enter the domain.
   → the brand now serves at the root of its own domain (no `/b/<slug>/`).
> The platform's own hostnames (`SAAS_BASE`, `PUBLIC_BASE_URL`, `BASE_URL`, `www.*`, `localhost`)
> are **reserved** — a brand attempting to claim one gets `reserved_domain`. This prevents a tenant
> from poisoning Host→tenant routing.

## 5. Plans & quotas
New brands start a **60-day Pro trial**, then default to **free** if they don't subscribe. Limits
are enforced server-side (and shown as usage meters in ⚙ แพ็กเกจ):

| Plan | Branches | Staff (non-owner) | Menu items | Orders/month | Custom domain |
|------|---------|-------------------|-----------|--------------|---------------|
| **Free** | 1 | 5 | 50 | 500 | — |
| **Pro** | 3 | 20 | unlimited | unlimited | — |
| **Business** | unlimited | unlimited | unlimited | unlimited | ✓ |

Over-quota writes return HTTP **402** (`branch_limit` / `staff_limit` / `menu_limit` /
`order_limit`). Admins can set any plan from **/admin** (plan dropdown) and extend a
trial/plan with the **ต่ออายุ** button.

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

## Security note (read before go-live)
- **`TRUST_PROXY_HOPS` must match your real infra.** It's how the true client IP is derived for
  every IP-based defense (signup throttle, PIN lockout, owner-login limiter, SSE connection cap).
  Render direct = `1` (the default). If you add a CDN/proxy in front, increase it by one per hop.
  Too high → clients can forge `X-Forwarded-For` to bypass rate limits; too low → all clients may
  share one bucket. When unsure, leave it at `1`.
- **Reserved domains:** brands cannot map a custom domain to the platform's own hostnames
  (`SAAS_BASE` / `PUBLIC_BASE_URL` / `BASE_URL` / `www.*` / `localhost`). This is enforced for both
  the owner self-service and admin paths.
- **Sessions** are HMAC-signed (timing-safe verify, expiry enforced) in `Secure; HttpOnly;
  SameSite=Lax` cookies (Secure auto-on in SaaS mode). Keep `SESSION_SECRET` secret and stable.

## Operating notes
- **Free plan spins down** after 15 min idle (cold start ~30s). Switch the service to `starter`
  (or add an uptime ping) once brands depend on it.
- **Backups:** Turso has its own backups; you can also adapt `scripts/backup-dump.js`.
- **Isolation** is enforced + tested (`npm run test:isolation`, `npm run dryrun`). Each brand's
  data, staff PINs, settings, loyalty, brand theme and LINE channel are fully separate.
- The `saas` branch is the SaaS code line; `main` stays the single-shop (YO-DEE) line. Merge
  `main`→`saas` to bring shop features into the SaaS; keep them separate to protect the live shop.

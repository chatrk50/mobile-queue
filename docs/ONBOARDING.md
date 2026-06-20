# Onboarding a new brand

This system is white-label: one brand = one instance (own Render service + Turso DB +
— for Package 2 — own LINE channels). Nothing here is shared with YO-DEE. Two packages:

| | **Package 1 — Mobile POS** | **Package 2 — LINE connecting** |
|---|---|---|
| Staff cashier + queue + reports | ✅ | ✅ |
| Customer ordering | at the counter | **in the LINE app** (LIFF) |
| LINE push / loyalty / online pay | — | ✅ |
| Needs LINE developer account | ❌ | ✅ |
| Env template | `brand.pos.env.example` | `brand.line.env.example` |

---

## Steps (≈15 min for Package 1)

1. **Deploy the code.** Create a new **Render** web service from this repo (or fork it).
   Build: `npm install` · Start: `npm start`.
2. **Create a database.** At [turso.tech](https://turso.tech) create a DB; copy its
   **URL + auth token** → set `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. (Skip only for a
   throwaway demo — without it data is wiped on every restart.)
3. **Set environment variables.** Copy the matching `brand.*.env.example` into Render's
   *Environment* tab and fill it in. The brand-defining ones:
   - `PACKAGE` = `pos` or `line`
   - `SEED=blank` (first boot creates one empty store+zone named from `BRAND_NAME`, **no**
     YO-DEE menu)
   - `BRAND_NAME`, `BRAND_SHORT`, `BRAND_THEME`, `BRAND_UNIT`
   - `CASHIER_PIN`, `PUBLIC_BASE_URL`
4. **Drop the logo.** Replace `public/assets/logo.png` with the brand's logo (square works
   best). Everything (titles, manifest icon, posters) follows it.
5. **First boot.** Open `PUBLIC_BASE_URL/cashier/`, log in with `CASHIER_PIN`, and add the
   menu + branches in ⚙ จัดการ. The store + Zone A already exist (from `SEED=blank`).
6. **Verify branding:** `/api/brand` returns your name/unit/package; the cashier title,
   colour and logo are the brand's; `/manifest.webmanifest` shows the brand (PWA install).

### Package 2 only — LINE setup
7. Create a LINE **Messaging API** channel + a **LINE Login** channel (same provider) and a
   **LIFF** app with endpoint `PUBLIC_BASE_URL/liff/`. Set `LINE_CHANNEL_ACCESS_TOKEN`,
   `LINE_CHANNEL_SECRET`, `LIFF_ID`.
8. Point the channel **webhook** to `PUBLIC_BASE_URL/line/webhook` and verify.
9. Print the QR poster from `/print/` and place it at the counter so customers can scan to
   order. Turn on loyalty / online pay in ⚙ จัดการ when ready.

---

## What `SEED` does
- `SEED=blank` → one empty store + Zone A, named from `BRAND_NAME`. **No** YO-DEE menu,
  ingredients, or reward. Use for every real new brand.
- `SEED=demo` → loads the YO-DEE sample menu (for trying the system out).
- unset → demo on an ephemeral DB (UAT), nothing forced on a durable DB (prod).

## Running the multi-tenant SaaS (self-service signup)

Instead of one instance per brand, you can run ONE multi-tenant deployment where brands
register themselves. Deploy this repo as a **separate** service (keep any single-tenant shop
on its own deployment) with:

```
SAAS=1                      # turns on /signup, /b/<slug>/ routing, per-tenant isolation
SAAS_ADMIN_PIN=<long random># platform-admin console at /admin
TURSO_DATABASE_URL=...      # durable DB (required)
TURSO_AUTH_TOKEN=...
PUBLIC_BASE_URL=https://<your-saas-host>
```

Then:
- **Brands self-register** at `https://<host>/signup` → pick name / package (pos|line) / unit /
  colour / owner PIN → instantly live at `https://<host>/b/<slug>/cashier/` (Pkg 1 fully usable;
  Pkg 2 = POS now + connect LINE next).
- **Pkg 2 brands connect LINE** themselves: cashier → ⚙ ตั้งค่าระบบ → "เชื่อมต่อ LINE" → paste
  their Channel token/secret + LIFF ID, then set their LINE webhook to the URL shown
  (`/b/<slug>/line/webhook`).
- **You manage everything** at `https://<host>/admin` (enter `SAAS_ADMIN_PIN`): list brands,
  suspend / reactivate, reset a locked-out owner's PIN.

Isolation is enforced at the data layer (every query scoped to the tenant) + boundary checks;
proven by `npm run test:isolation`. Each brand's data, staff PINs, settings, loyalty, brand
theme and LINE channel are fully separate. See **SAAS-ADMIN-PLAN.md** for roles/auth detail.

## Switching package later
Change `PACKAGE` and redeploy — it only flips feature visibility, data is untouched. Going
`line → pos` hides the LINE/customer UI; `pos → line` reveals it (then do the LINE setup).

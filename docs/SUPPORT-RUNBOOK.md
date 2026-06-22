# Support / Operations Runbook (SaaS platform admin)

Practical procedures for running the multi-tenant SaaS — suspend a shop, reset a locked owner,
change a plan, handle PDPA requests, review the audit trail, enable 2FA, deal with refunds.
Everything here is done from the **platform-admin console** (`/admin`) unless noted.

> Scope: this is the **platform** admin (you, the operator) managing **all** brands. It is NOT a
> brand owner's cashier (each shop owner manages their own till at `/b/<slug>/cashier/`).

---

## 0. Access the admin console

- URL: `https://<your-saas-host>/admin`
- Sign in with **`SAAS_ADMIN_PIN`** (set in the host env). If **2FA is enabled**
  (`SAAS_ADMIN_TOTP_SECRET` set), you'll also be asked for the rotating 6-digit code from your
  authenticator app (see §6).
- Brute-force protection: **6 wrong attempts → 15-minute lockout** (per IP). If you lock yourself
  out, wait it out or restart the service (clears the in-memory counter).
- The console is the ONLY thing gated by the admin PIN. It is not tenant-scoped — you see every brand.

---

## 1. Suspend / reactivate a shop

When to suspend: non-payment past grace, abuse, or owner request to pause.

1. `/admin` → find the brand row → **ระงับ (Suspend)**.
2. Effect: the shop's `/b/<slug>/…` returns **403** for everyone (owner + customers). Data is kept.
3. Reactivate: **เปิดใช้ (Activate)** on the same row.
4. The **primary tenant (YO-DEE, id 1) cannot be suspended** — by design.
5. Logged to the audit trail as `tenant.suspend` / `tenant.activate`.

---

## 2. Reset a locked-out owner's PIN

When an owner is locked out of their till (forgot PIN / too many wrong tries).

1. `/admin` → brand row → **รีเซ็ต PIN (Reset PIN)** → confirm.
2. The console shows a **new 4-digit PIN once** — relay it to the owner over a trusted channel and
   tell them to change it immediately in their cashier (⚙ → พนักงาน).
3. The new PIN is **never written to the audit log** (only that a reset happened + which staff row).
4. Logged as `tenant.reset_pin`.

> The owner's till lockout (wrong PIN at the cashier) is separate and self-clears; a reset is only
> needed when they've genuinely lost the PIN.

---

## 3. Change a shop's plan

Manual plan control (e.g. comp a founder, downgrade after cancellation the gateway didn't catch).

1. `/admin` → brand row → **Plan** dropdown → pick `free` / `pro` / `business`.
2. Quotas apply immediately (branches per plan, custom domain on business, etc.).
3. Logged as `tenant.plan`.
4. For paid self-service the owner upgrades in their own ⚙ → billing (Omise); use this only for
   manual/support overrides.

---

## 4. Map a custom domain (Business plan)

1. Owner points a CNAME for their domain at the SaaS host, and the host (Render) adds the cert.
2. `/admin` → brand row → **โดเมน (Domain)** → enter `shop.brand.com` (blank to clear).
3. Logged as `tenant.domain`. The shop then resolves at that host as well as `/b/<slug>/`.

---

## 5. Audit trail — who did what

1. `/admin` → **📜 บันทึกการใช้งาน (audit)**.
2. Shows time · brand · actor (`admin` or `owner:<staffId>`) · action · detail · IP for every
   sensitive action: suspend/activate/plan/domain/reset_pin, LINE config changes, PDPA export/erasure,
   tenant export/delete.
3. **Secrets are never recorded** — reset PINs and LINE token/secret values are deliberately excluded;
   only *which* fields changed is logged.
4. Use this first when investigating "who changed X" or a suspected incident.

---

## 6. Enable / manage admin 2FA

Strongly recommended — the admin PIN controls every tenant.

1. Run: `node scripts/admin-2fa-setup.mjs` → it prints a base32 secret + an `otpauth://` URL.
2. Add it to your authenticator (scan the URL as a QR, or paste the secret).
3. Set **`SAAS_ADMIN_TOTP_SECRET=<that secret>`** in the host env → redeploy.
4. Verify before relying on it: `SAAS_ADMIN_TOTP_SECRET=<secret> node scripts/admin-2fa-setup.mjs <6-digit-code>`.
5. From then on, admin login needs PIN **+** code → an 8-hour admin session. To rotate, generate a
   new secret and update the env. To disable, unset the env var (reverts to PIN-only).

---

## 7. PDPA — data subject requests

### 7a. A customer asks for their data / erasure (right to be forgotten)
- The **shop owner** handles this from their own cashier: ⚙ → PDPA → export / forget-customer
  (by phone or key). Erasure removes the customer + loyalty rows and anonymises their tickets.

### 7b. A whole shop wants its data exported (portability)
1. `/admin` → brand row → **⬇️ ส่งออก (Export)** → downloads a full JSON snapshot
   (stores, zones, menu, customers, orders, …). Logged as `tenant.export`.

### 7c. A shop closes its account / requires full erasure
1. **Export first** (§7b) and send the owner the snapshot — this is irreversible.
2. `/admin` → brand row → **🗑️ ลบถาวร (Delete permanently)** → confirm → **type the slug exactly**.
3. Effect: hard-deletes the tenant and **every** row it owns across all tables, in one transaction.
   The primary tenant (id 1) is refused. Logged as `tenant.delete` (with row count, no data).
4. Verify: the shop's `/b/<slug>/` now 404s and it's gone from the tenant list.

---

## 8. Refunds & money

**The platform holds no money.** Each shop's sales settle directly to that shop's own account
(PromptPay / KShop / bank / LINE Pay), and subscription charges go through Omise to your platform
account.

- **A shop's customer wants a refund:** the shop owner voids/refunds the order in their own till
  (it's recorded as a refund in their reports). You do not touch customer money.
- **A subscription refund (a shop disputes a charge):** issue it from the **Omise dashboard**, then
  set their plan appropriately in `/admin` (§3). The Omise webhook also downgrades on a refund event.
- Never enter anyone's card/bank details yourself — direct them to the relevant dashboard.

---

## 9. Quick incident checklist

- **"A shop can't log in"** → check it's not suspended (§1); if PIN lost, reset (§2).
- **"Someone changed our settings"** → audit trail (§5), filter by that brand.
- **"Suspected admin compromise"** → rotate `SAAS_ADMIN_PIN` + `SESSION_SECRET` (invalidates all
  admin/owner sessions) in the host env, redeploy, enable 2FA (§6), review the audit trail.
- **"Is data safe after a crash?"** → durable Turso DB + the daily backup workflow (90-day artifacts);
  restore is drill-tested (`npm run test:restore`).
- **CI red** → check the `test` job (regression) and the `secrets` job (gitleaks) in GitHub Actions.

---

## 10. Related docs

- Deployment & env: [`SAAS-DEPLOY.md`](SAAS-DEPLOY.md) · admin design: [`SAAS-ADMIN-PLAN.md`](SAAS-ADMIN-PLAN.md)
- Onboarding: [`ONBOARDING.md`](ONBOARDING.md) · pricing: [`GTM-PRICING.md`](GTM-PRICING.md)
- Data handling & retention: [`DATA-RETENTION.md`](DATA-RETENTION.md)
- Durable DB & backups: [`durable-db-turso.md`](durable-db-turso.md)

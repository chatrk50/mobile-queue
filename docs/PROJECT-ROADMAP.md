# Project roadmap & readiness — LINE-first POS/Queue SaaS

_Single source of truth for "what should we have, must-have first, in what order" across every
perspective. Prioritised MoSCoW (Must / Should / Could / Won't-yet). Status as of the latest
`saas` branch._

---

## 0. Status snapshot
Built + verified on `saas` (YO-DEE prod on `main` untouched). ~130 automated checks green:
`test:e2e` (financial invariants) · `test:tenant` 11 · `test:isolation` 15 · `test:billing` 24 ·
`test:hierarchy` 43 (RBAC + backdoor + security headers + lockout) · `dryrun` 32.

Working end-to-end: signup → 60-day trial → self-serve pay (Omise, Pro/Business, monthly/yearly,
founder, referral) → onboard → multi-tenant isolation → per-tenant LINE + brand + custom domain →
platform admin → owner email/Google login → PDPA export/erasure → security hardening.

---

## 1. SECURITY — protect customers from attackers (highest priority, ongoing)

### Done ✅
- Tenant data isolation (every query scoped) + boundary ownership guards — `test:isolation`.
- RBAC: platform-admin / owner / manager / cashier, all enforced — `test:hierarchy`.
- Closed 3 real bugs found by adversarial testing: **global-PIN cross-tenant backdoor**,
  **path-routing leaking to tenant 1**, **forgeable sessions (known SESSION_SECRET default)**.
- Fail-closed: SaaS won't boot without a strong `SESSION_SECRET`.
- Security headers (nosniff, X-Frame-Options + CSP frame-ancestors, Referrer-Policy,
  Permissions-Policy, HSTS), `x-powered-by` off, `Secure` session cookies (SaaS).
- Brute-force lockout on staff + platform-admin PINs; signup/owner-login rate-limited.
- Scrypt-hashed PINs/passwords; HMAC-signed sessions; parameterised SQL (tenant ids are ints).
- No custody of merchant funds (avoids payment-licensing risk); card data never hits our server.
- `npm audit`: HIGH (form-data CRLF) patched.

### Done (security finish) ✅
- [x] **Hardened CSP** — source-allowlist (default-src 'self'; script/style/font/img/connect/frame
      restricted to self + Google/Omise/LINE/fonts; object-src none; base-uri/form-action self).
      Blocks injected external scripts + exfil. (Nonce-strict CSP for inline scripts is deferred —
      it needs a full handler rewrite; stored-XSS is defended at the source instead.)
- [x] **Stored-XSS sweep** — customer-controlled `customer_name` confirmed escaped; escaped owner-set
      store/zone names on display/hub/poster; admin onclick XSS fixed earlier. `test:hierarchy` checks.
- [x] **0 dependency vulnerabilities** (`npm audit`) — uuid override + form-data patch.
- [x] **Backup + verified restore drill** (`npm run test:restore` — dump → replay → assert 6/6).
### Must (still, before real customers) 🔴
- [ ] **Secrets hygiene**: confirm no secret in git; rotate any test keys before prod (SESSION_SECRET
      now enforced/fail-closed). [ ] Nonce-strict CSP (large refactor — later hardening).

### Should 🟠
- [x] Per-tenant audit log (who changed what) for owner + admin actions — `audit_log` table +
      logAudit/listAudit; admin/owner sensitive actions recorded (no secrets); `📜` admin panel +
      `GET /admin/api/audit`. (commit 36b252c)
- [x] Account lockout on owner-login (ownerHits, 10 fails → 429) — already in place; admin PIN too.
- [x] 2FA for the platform-admin console — optional RFC-6238 TOTP via SAAS_ADMIN_TOTP_SECRET
      (PIN + code → 8h admin session; PIN-alone rejected when on; brute-force lockout). Setup:
      scripts/admin-2fa-setup.mjs. Tests test:totp + test:2fa. (commit 6fc432d)
- [ ] Alerting on suspicious owner-login patterns (lockout done; alerting needs a channel).
- [x] Dependency scanning + full test suite in CI on every push/PR (`npm audit --audit-level=high`
      gate + e2e/tenant/isolation/billing/restore/totp/2fa/hierarchy/dryrun). `.github/workflows/ci.yml`
      (commit 19bd6d8). [x] secret scanning — gitleaks `secrets` job + .gitleaks.toml (commit 69bc2b6).
- [ ] Pen-test / external security review before scaling.

---

## 2. Product / functionality
**Must:** (all built) POS, queue, LINE order, loyalty, inventory/BOM, P&L, multi-branch, packages.
**Should:**
- [x] Modernise the **cashier/LIFF UI** — full SVG icon set (IC registry: cash, cup, clock, kitchen,
      bell, check, phone, ticket, target, star, timer); all queue-board + today-stats emoji replaced.
- [x] Owner **dashboard** (KPIs, trends) as the post-login home — 5-chip KPI row (revenue, gross,
      net, margin, cups) + history charts; owners/managers land here on login.
- [ ] Receipt **printer** support (ESC/POS) — code prepared, needs hardware test.
**Could:** delivery integration (Grab/LINEMAN), e-Tax invoices, owner mobile app, vouchers/promos.

## 3. Billing / monetisation
**Done:** Free/Pro/Business × monthly/yearly, 60-day trial, founder, referral, quota, dunning banner.
**Must:** [ ] **Live Omise test** with real test keys (card charge end-to-end).
**Should:** [x] Email dunning scaffolding (SendGrid REST, dry-run fallback, dunning_log idempotency,
admin preview/send panel) · [x] proration on upgrade (prorateUpgrade — credit = remaining days ×
daily rate; cashier routes card-holders to /api/billing/upgrade directly) · [ ] Stripe alternative.

## 4. Infra / reliability
**Must:** [ ] **Always-on hosting** (Render Starter — free tier sleeps) · [ ] DB backups (§1) ·
[x] uptime monitor + status page (/health plain-text + /status JSON; live widget on /status page) ·
[x] error tracking (in-process ring buffer _APP_ERRORS 200 entries; /admin/api/errors panel).
**Should:** [ ] staging for the SaaS branch · [ ] DB scaling plan (Turso paid tier triggers) ·
[x] CI running the test suite on every push (.github/workflows/ci.yml — audit + e2e + isolation +
tenant + billing + restore + totp + 2fa + hierarchy + dryrun + secret scanning).

## 5. Legal / compliance (TH)
**Done:** PDPA customer export/erasure + /privacy + /terms; no fund custody. **Tenant-level**
export + hard-erasure (admin-gated, slug-confirmed, audit-logged; verified zero-orphan across 25
tables) — commit da7a4ca.
**Must:** [ ] register a legal entity to invoice/collect · [ ] DPA template for tenants ·
[ ] VAT registration trigger plan (>฿1.8M/yr).
**Should:** [x] cookie/consent notice (PDPA banner — shared /assets/consent.js, localStorage
      dismissal, injected on landing/signup/login/liff/status/cashier) · [x] tenant erasure capability (manual admin-initiated;
auto-purge-on-close still optional) · [x] written data-retention policy doc — [`DATA-RETENTION.md`](DATA-RETENTION.md).

## 6. GTM / growth
**Done:** pricing, trial, founder, referral, landing/pricing mockup.
**Must:** [ ] case study (YO-DEE) + 3–5 founder testimonials · [ ] LINE OA support channel.
**Should:** [x] vertical templates (yogurt/coffee/tea/food/bakery) — one-tap starter menus in the
cashier empty state + `/api/menu-templates` & `/api/admin/apply-template` (commit 3dde7af) ·
[ ] FB/LINE community seeding ·
[x] onboarding wizard (first-menu) — first-run activation checklist in the cashier (add item →
brand → LINE → open), owner-only, auto-hides once activated (commit fe5cc55) · [x] referral
tracking dashboard — 🎁 admin panel (invite code · referred-by · count + % via referral + top
referrers); GET /admin/api/referrals (commit f3f8d4d).

## 7. Support / ops
**Must:** [ ] LINE OA support + FAQ + short Thai videos · [x] runbook (suspend, reset-PIN, refund,
PDPA, 2FA, incident) — [`SUPPORT-RUNBOOK.md`](SUPPORT-RUNBOOK.md).
**Should:** [x] in-app help/tours (help center + /help/line guide + first-run checklist) ·
[ ] admin "impersonate for support" (audited — deferred: adds attack surface, needs owner sign-off) ·
[x] churn/usage view — 📊 admin health panel (expiring-soon, inactive, plan mix, MRR estimate)
(commit f1d64de).

---

## 8. Phased plan (priority order)
- **Phase A — security & reliability gate (do FIRST):** strict CSP + XSS audit + backups + always-on
  + error tracking + secrets rotation. *Don't take real money until this passes.*
- **Phase B — monetisation live:** Omise live test, receipts, entity/VAT, dunning email.
- **Phase C — soft launch:** founders-50, YO-DEE case study, LINE OA support, onboarding wizard.
- **Phase D — polish & scale:** cashier/LIFF modern UI, owner dashboard, delivery/e-Tax, CI,
  pen-test, mobile app.

## 9. "Must-have before charging real money" — the gate
1. Strong `SESSION_SECRET` (enforced) ✅ · 2. Always-on hosting ⬜ · 3. DB backup + restore drill ✅
(`test:restore`) · 4. Live Omise verified ⬜ · 5. Hardened CSP + XSS sweep ✅ · 6. Legal entity +
ToS/PDPA live (ToS/PDPA ✅, entity ⬜) · 7. Support channel ⬜ · 8. Uptime + error monitoring ⬜.
> Remaining gate items are operational/owner actions (hosting, Omise keys, entity, support,
> monitoring) — the code-side security gate is met. 0 dep CVEs; ~140 automated checks green.

> Verification is a control, not a one-off: re-run the full suite on every change; treat a new
> feature as unshipped until `test:hierarchy` + `test:isolation` are green.

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
      (commit 19bd6d8). [ ] secret scanning (e.g. gitleaks) still to add.
- [ ] Pen-test / external security review before scaling.

---

## 2. Product / functionality
**Must:** (all built) POS, queue, LINE order, loyalty, inventory/BOM, P&L, multi-branch, packages.
**Should:**
- [ ] Modernise the **cashier/LIFF UI** to the new theme (only signup/login done so far).
- [ ] Owner **dashboard** (KPIs, trends) as the post-login home.
- [ ] Receipt **printer** support (ESC/POS) — code prepared, needs hardware test.
**Could:** delivery integration (Grab/LINEMAN), e-Tax invoices, owner mobile app, vouchers/promos.

## 3. Billing / monetisation
**Done:** Free/Pro/Business × monthly/yearly, 60-day trial, founder, referral, quota, dunning banner.
**Must:** [ ] **Live Omise test** with real test keys (card charge end-to-end).
**Should:** [ ] Email dunning + receipts/e-Tax (needs email + tax provider) · [ ] proration on
upgrade · [ ] Stripe alternative for non-TH.

## 4. Infra / reliability
**Must:** [ ] **Always-on hosting** (Render Starter — free tier sleeps) · [ ] DB backups (§1) ·
[ ] uptime monitor + status page · [ ] error tracking (Sentry-style).
**Should:** [ ] staging for the SaaS branch · [ ] DB scaling plan (Turso paid tier triggers) ·
[ ] CI running the test suite on every push.

## 5. Legal / compliance (TH)
**Done:** PDPA customer export/erasure + /privacy + /terms; no fund custody. **Tenant-level**
export + hard-erasure (admin-gated, slug-confirmed, audit-logged; verified zero-orphan across 25
tables) — commit da7a4ca.
**Must:** [ ] register a legal entity to invoice/collect · [ ] DPA template for tenants ·
[ ] VAT registration trigger plan (>฿1.8M/yr).
**Should:** [ ] cookie/consent notice · [x] tenant erasure capability (manual admin-initiated;
auto-purge-on-close still optional) · [ ] written data-retention policy doc.

## 6. GTM / growth
**Done:** pricing, trial, founder, referral, landing/pricing mockup.
**Must:** [ ] case study (YO-DEE) + 3–5 founder testimonials · [ ] LINE OA support channel.
**Should:** [ ] vertical templates (yogurt/coffee/food) · [ ] FB/LINE community seeding ·
[x] onboarding wizard (first-menu) — first-run activation checklist in the cashier (add item →
brand → LINE → open), owner-only, auto-hides once activated (commit fe5cc55) · [ ] referral
tracking dashboard.

## 7. Support / ops
**Must:** [ ] LINE OA support + FAQ + short Thai videos · [ ] runbook (suspend, reset-PIN, refund).
**Should:** [ ] in-app help/tours · [ ] admin "impersonate for support" (audited) · [ ] churn/usage view.

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

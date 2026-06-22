# Data Retention Policy

How long the platform keeps data, and how it is exported or erased. Pairs with the customer-facing
[`/privacy`](../public/privacy/index.html) notice and the operator [`SUPPORT-RUNBOOK.md`](SUPPORT-RUNBOOK.md).
Thailand PDPA-aligned. Dates/periods are configurable; the defaults shipped are listed below.

## What we hold

| Data | Where | Purpose |
|------|-------|---------|
| Brand/account (name, slug, owner email, plan) | `tenants` | run the subscription |
| Staff PINs (scrypt-hashed) | `staff` | till login |
| Menu, branches, prices, ingredients | per-tenant tables | run the shop |
| Orders, tickets, payments, sales history | per-tenant tables | operations + reports |
| Customer records (LINE id or phone-key, name, loyalty points, optional birthday) | `customers`, `loyalty_moves` | loyalty + reorder |
| Sensitive-action audit log (actor, action, IP — **no secrets**) | `audit_log` | security forensics |
| Payment **tokens/card data** | **none — not stored** | Omise holds card data; shops settle to their own accounts |

## Retention periods (defaults)

- **Active account:** business data is retained for the life of the subscription (operational need).
- **Customer personal data:** retained while the account is active; erased on request (see below) or
  when the shop account is deleted.
- **Backups:** the daily DB backup workflow keeps each dump as an artifact for **90 days**
  (`.github/workflows/backup.yml`, `retention-days: 90`), then it auto-expires.
- **Audit log:** retained while the tenant exists (deleted with the tenant on erasure).
- **Closed/abandoned accounts:** no automatic purge today — erasure is operator-initiated (a
  deliberate, slug-confirmed action) so nothing is destroyed by surprise. A scheduled auto-purge of
  long-suspended accounts is an optional future addition.

## Subject rights (PDPA)

- **Access / portability — customer:** the shop owner exports/returns the customer's data from their
  cashier (⚙ → PDPA).
- **Erasure — customer ("right to be forgotten"):** owner runs ⚙ → PDPA → forget-customer (by phone
  or key); removes the customer + loyalty rows and anonymises their tickets.
- **Access / portability — whole shop:** platform admin exports a full JSON snapshot
  (`/admin` → ⬇️ Export).
- **Erasure — whole shop (account close-out):** platform admin hard-deletes the tenant and every row
  it owns in one transaction (`/admin` → 🗑️ Delete, slug-confirmed). Irreversible; export first.
  Verified zero-orphan across all tenant-scoped tables (`npm run test:isolation`).

## Security of held data

- Secrets (LINE tokens/secrets, session secret, admin PIN/2FA, DB tokens) live only in host env vars,
  never in git (enforced by the gitleaks CI scan) and never in the audit log.
- Staff PINs are scrypt-hashed; sessions are HMAC-signed and expire.
- Admin console: PIN + optional TOTP 2FA, brute-force lockout, security headers, Secure cookies.
- Tenant isolation is enforced on every query and verified by the isolation test suite.

## Operator actions on incident or closure

See [`SUPPORT-RUNBOOK.md`](SUPPORT-RUNBOOK.md) §7 (PDPA requests) and §9 (incident checklist).

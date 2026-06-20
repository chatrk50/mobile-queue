# SaaS — Admin, Authentication & Authorization plan

How multiple brand customers sign up, log in, and are managed — and how the platform
owner administers them. Single-tenant (YO-DEE) is unaffected: it runs with `SAAS` unset,
everything is tenant 1, and none of the SaaS surfaces are reachable.

## Roles (three levels)

| Role | Scope | Auth | Can do |
|---|---|---|---|
| **Platform admin** (us) | ALL tenants | `SAAS_ADMIN_PIN` (separate from any shop) | list / suspend / reactivate tenants, reset a tenant owner's PIN, view usage, impersonate for support |
| **Tenant owner** | one tenant | staff PIN (role `owner`), scoped to the tenant | everything in their shop: menu, branches, staff, reports, settings, LINE connect |
| **Tenant manager / cashier** | one tenant | staff PIN (role `manager`/`cashier`) | existing per-role cashier permissions, within their tenant only |

The existing `owner / manager / cashier` roles are unchanged — they just become **per-tenant**.
The only new identity is the **platform admin**, which sits above all tenants.

## Authentication

- **Tenant resolution first.** Every request under `/b/<slug>/…` resolves `slug → tenant`
  (A.2 middleware) and runs in that tenant's context. No slug (single-tenant) ⇒ tenant 1.
- **Staff login is tenant-scoped.** `staffByPin()` only matches staff rows with the request's
  `tenant_id`. So the same PIN at brand A and brand B are different logins; a PIN never works
  across tenants. Sessions already carry the staff id → tenant is implied by the staff row.
- **Platform admin login** is separate: `POST /admin/login` checks `SAAS_ADMIN_PIN` (env on the
  SaaS service only) and issues an admin session. Never a staff row, never tied to a tenant.
- **Suspended tenant** (`tenants.active=0`) ⇒ all its routes return 403 (a friendly "บัญชีถูกระงับ"
  page); the platform admin can still see/reactivate it.

## Authorization

- Data isolation is enforced at the **data layer** (A.2: every query scoped to the tenant) +
  **boundary ownership checks** (a store/zone/ticket id in a URL must belong to the request's
  tenant, else 404). This is defence-in-depth: even a guessed id from another tenant is rejected.
- Per-tenant role gates are the existing `ownerOK / managerOK / pinOK` — they keep working, now
  within the resolved tenant.
- Platform-admin routes are gated by `adminOK` (admin session OR `SAAS_ADMIN_PIN`), independent
  of any tenant.

## Onboarding / signup flow (Phase B)

```
/signup  → name, owner email, package (pos|line), desired PIN
   → createTenant() (unique slug + brand) + seed an `owner` staff row with the PIN (tenant-scoped)
   → redirect to /b/<slug>/cashier/  → owner logs in with their PIN → adds menu/branches
   (Pkg 1 usable immediately; Pkg 2 also shows a "Connect LINE" step — paste own tokens)
```
- Rate-limit signups (per IP) and validate email; slug auto-dedupes.
- No payment/credentials handled by us at signup (PIN is chosen by the owner in the form, then
  immediately hashed). Billing is a later, separate concern.

## Platform-admin backend (Phase D)

A minimal `/admin` console (super-admin only):
- **Tenant list** — name, slug, package, plan, active, created, basic counts (stores/orders).
- **Suspend / reactivate** — toggle `tenants.active` (suspended ⇒ shop 403).
- **Reset owner PIN** — issue a temporary PIN for a locked-out brand owner.
- **Impersonate (support)** — open a tenant's cashier in a read-mostly admin context (audited).
- **Usage** — orders/day per tenant (for plan limits / future billing).

API (all `adminOK`): `GET /admin/api/tenants`, `POST /admin/api/tenants/:id/suspend`,
`POST /admin/api/tenants/:id/activate`, `POST /admin/api/tenants/:id/reset-pin`.

## Security checklist
- [ ] Tenant scoping on every read/write (A.2) + isolation tests (A.3).
- [ ] Boundary ownership checks on every `:storeId/:zoneId/:ticketId` route.
- [ ] Staff PIN matching scoped to tenant; brute-force lockout already exists (keep, per-tenant).
- [ ] Customer/loyalty keys namespaced per tenant (A.2b — same phone at two brands ≠ same row).
- [ ] Suspended-tenant 403; platform-admin routes never tenant-scoped.
- [ ] `SAAS_ADMIN_PIN` only on the SaaS service; never in git; long + random.
- [ ] Signup rate-limited; slug/email validated.

## Build order
A.2 isolation (data layer + middleware + ownership) → A.3 isolation tests → **B /signup** (the
link) → C per-tenant LINE connect → **D /admin console**. Platform-admin gating (`adminOK`,
suspended-tenant 403) lands with A.2 so the security boundary exists before signups open.

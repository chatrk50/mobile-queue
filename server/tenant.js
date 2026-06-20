// ---------------------------------------------------------------------------
// Multi-tenant context (SaaS). The whole app is single-tenant by default
// (tenant 1 = the original business, e.g. YO-DEE). When SAAS=1 the app serves
// many brands, each identified by a tenant id resolved per request.
//
// We carry the "current tenant" in an AsyncLocalStorage so request handlers and
// the data layer can read it WITHOUT threading a tenantId through every function.
// Outside any request (boot, scripts, tests) currentTenantId() === 1, so the
// existing single-tenant behaviour is preserved exactly (no-op for tenant 1).
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from 'node:async_hooks';

// Master switch: only the dedicated SaaS deployment sets SAAS=1. Off => classic
// single-tenant app (registration disabled, every request is tenant 1).
export const SAAS = String(process.env.SAAS ?? '0') === '1';

// The base host the SaaS runs under (for building per-tenant links), e.g.
// "pos.example.com". Optional; path-based routing works without it.
export const SAAS_BASE = (process.env.SAAS_BASE || '').trim();

export const DEFAULT_TENANT = 1;

const als = new AsyncLocalStorage();

/** Run `fn` with `tenantId` as the current tenant for everything it (a)synchronously calls. */
export function runWithTenant(tenantId, fn) {
  return als.run({ tenantId: Number(tenantId) || DEFAULT_TENANT }, fn);
}

/** The tenant for the active request, or 1 outside a request / in single-tenant mode. */
export function currentTenantId() {
  const store = als.getStore();
  return (store && store.tenantId) || DEFAULT_TENANT;
}

/** A url-safe slug from a brand name (a-z0-9 + dashes). Used as the tenant's routing key. */
export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'brand';
}

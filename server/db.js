// Storage layer with TWO interchangeable backends, chosen at boot:
//
//  • DEFAULT — Node's BUILT-IN SQLite (node:sqlite, Node 22+). No native build,
//    no extra dependency. Data lives in a local file, which on Render's free
//    tier is EPHEMERAL (wiped on every restart/redeploy/spin-down).
//
//  • DURABLE — Turso / libSQL "embedded replica" (the `libsql` driver), enabled
//    only when TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) are set. Reads are served
//    from a fast local replica; writes are forwarded to the Turso cloud primary
//    and we sync() so nothing is lost when the local disk is wiped. On boot we
//    pull the cloud copy back, so daily/monthly sales history (and all data)
//    survives restarts. SQLite-compatible, so the schema/queries are unchanged.
//
// Both expose the same prepare/run/get/all/transaction shim, so the rest of the
// app is identical regardless of which backend is active.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { createHash, randomBytes } from 'node:crypto';
import { hashPin, verifyPin } from './auth.js';
import { currentTenantId, slugify } from './tenant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.QUEUE_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'queue.db');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const USE_TURSO = /^(libsql|https?):\/\//.test(TURSO_URL);

let raw;
let scheduleSync = () => {};   // debounced background push/pull (durable mode only)

// `libsql` is an optional native dependency — load it only when Turso is
// configured, and fall back to local mode (loudly) if it isn't installed.
let Database = null;
if (USE_TURSO) {
  try { ({ default: Database } = await import('libsql')); }
  catch (e) {
    console.error('[db] TURSO_DATABASE_URL is set but the `libsql` driver is not installed (' + e.message + '). Falling back to LOCAL (ephemeral) storage. Run `npm install libsql` to enable durable mode.');
  }
}

if (USE_TURSO && Database) {
  raw = new Database(dbPath, { syncUrl: TURSO_URL, authToken: TURSO_TOKEN });
  // Pull the durable copy into the local replica before the app reads anything.
  try { raw.sync(); } catch (e) { console.error('[db] initial Turso sync failed:', e.message); }

  // Debounce writes into a single sync (batches bursts of orders) and never let
  // two syncs overlap. sync() may be sync or return a promise depending on build.
  let timer = null, dirty = false, syncing = false;
  const doSync = () => {
    if (syncing) { dirty = true; return; }
    syncing = true;
    try {
      const r = raw.sync();
      if (r && typeof r.then === 'function') r.then(() => { syncing = false; if (dirty) { dirty = false; doSync(); } }, (e) => { syncing = false; console.error('[db] Turso sync failed:', e.message); });
      else { syncing = false; if (dirty) { dirty = false; doSync(); } }
    } catch (e) { syncing = false; console.error('[db] Turso sync failed:', e.message); }
  };
  scheduleSync = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; if (dirty) { dirty = false; doSync(); } }, 800);
    if (timer.unref) timer.unref();
  };
  // Safety net: periodic sync even if writes are quiet, + flush on shutdown.
  const iv = setInterval(doSync, 60_000); if (iv.unref) iv.unref();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { raw.sync(); } catch { /* best effort */ } process.exit(0); });
  }
  // Short-lived processes (e.g. `npm run seed`) finish before the debounced sync
  // fires — flush synchronously on exit so their writes reach the Turso primary.
  process.on('exit', () => { try { raw.sync(); } catch { /* best effort */ } });
  console.log('[db] Durable mode ON — Turso/libSQL embedded replica');
} else {
  const { DatabaseSync } = await import('node:sqlite');
  raw = new DatabaseSync(dbPath);
  console.log('[db] Local mode — node:sqlite (ephemeral on Render free; set TURSO_DATABASE_URL for durable storage)');
}

// True only when Turso/libSQL durable storage is actually active. Ephemeral (false) =
// node:sqlite — used by the UAT sandbox, where the app auto-seeds demo data on boot.
export const DURABLE = Boolean(USE_TURSO && Database);

// WAL improves concurrency but isn't supported on some mounted/networked FS;
// fall back to the default rollback journal if it can't be enabled.
try { raw.exec('PRAGMA journal_mode = WAL'); } catch { /* default journal */ }
try { raw.exec('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }

// libSQL's .get() attaches a non-column `_metadata` field — strip it so it never
// leaks into API responses (node:sqlite rows don't have it; the check is cheap).
const stripMeta = (row) => { if (row && typeof row === 'object' && '_metadata' in row) delete row._metadata; return row; };
const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const SCHEMA_OR_WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

// Cache compiled statements by SQL text. raw.prepare() has real cost on libSQL, and hot paths
// (zoneSnapshot runs ~30 queries) re-prepare the same SQL on every request — caching turns that
// into a one-time compile, cutting hundreds of ms per cashier action. Safe: statements are
// reused read-only with fresh args each call (single-threaded, sequential).
const _stmtCache = new Map();
const _wrapCache = new Map();
// Compatibility wrapper: prepare(...).run/get/all, exec, transaction()
export const db = {
  prepare(sql) {
    let wrap = _wrapCache.get(sql);
    if (wrap) return wrap;
    let st = _stmtCache.get(sql);
    if (!st) { st = raw.prepare(sql); _stmtCache.set(sql, st); }
    const mutating = MUTATING.test(sql);
    wrap = {
      run: (...a) => { const r = st.run(...a); if (mutating) scheduleSync(); return r; },
      get: (...a) => stripMeta(st.get(...a)),
      all: (...a) => st.all(...a).map(stripMeta),
    };
    _wrapCache.set(sql, wrap);
    return wrap;
  },
  exec(sql) { const r = raw.exec(sql); if (SCHEMA_OR_WRITE.test(sql)) scheduleSync(); return r; },
  // Mimics better-sqlite3 transaction(fn) -> function returning fn's result.
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); scheduleSync(); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    };
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  is_open     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL DEFAULT 'A',
  is_open     INTEGER NOT NULL DEFAULT 1,
  last_number INTEGER NOT NULL DEFAULT 0,
  last_called INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  zone_id      INTEGER NOT NULL REFERENCES zones(id),
  number       INTEGER NOT NULL,
  code         TEXT NOT NULL,
  party_size   INTEGER NOT NULL DEFAULT 1,
  line_user_id TEXT,
  customer_name TEXT,
  called_count INTEGER NOT NULL DEFAULT 0,
  rating       INTEGER,
  status       TEXT NOT NULL DEFAULT 'waiting',
  notified_soon INTEGER NOT NULL DEFAULT 0,
  client_token TEXT,
  numbered_at  TEXT,
  making_at    TEXT,
  cancel_requested TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  called_at    TEXT,
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_zone_status ON tickets(zone_id, status);
CREATE TABLE IF NOT EXISTS daily_stats (
  date         TEXT NOT NULL,
  zone_id      INTEGER NOT NULL,
  issued       INTEGER NOT NULL DEFAULT 0,
  served       INTEGER NOT NULL DEFAULT 0,
  no_shows     INTEGER NOT NULL DEFAULT 0,
  avg_wait_sec INTEGER,
  avg_rating   REAL,
  PRIMARY KEY (date, zone_id)
);
CREATE TABLE IF NOT EXISTS menu_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,              -- Thai name (primary line)
  name_en  TEXT,                       -- English name (smaller line)
  price    REAL NOT NULL DEFAULT 0,
  image    TEXT,                       -- product photo URL (optional)
  category TEXT NOT NULL DEFAULT 'drink',  -- 'drink' | 'topping'
  active   INTEGER NOT NULL DEFAULT 1,     -- 0 = hidden from menus
  soldout  INTEGER NOT NULL DEFAULT 0,     -- 1 = visible but not orderable (SOLD OUT badge)
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  total      REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'cashier',   -- 'cashier' | 'customer' (self-order via LINE)
  payment_status TEXT NOT NULL DEFAULT 'unpaid', -- 'unpaid' | 'paid' | 'void'
  paid_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  name      TEXT NOT NULL,
  price     REAL NOT NULL DEFAULT 0,
  qty       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_orders_ticket ON orders(ticket_id);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS sales_history (
  date        TEXT NOT NULL,              -- 'YYYY-MM-DD' (Asia/Bangkok)
  branch_id   INTEGER NOT NULL DEFAULT 1, -- which branch this daily row summarizes
  cups        INTEGER NOT NULL DEFAULT 0, -- drinks sold (excl. voided)
  revenue     REAL NOT NULL DEFAULT 0,
  gross       REAL NOT NULL DEFAULT 0,
  net         REAL NOT NULL DEFAULT 0,
  void_orders INTEGER NOT NULL DEFAULT 0,
  void_cups   INTEGER NOT NULL DEFAULT 0,
  void_amount REAL NOT NULL DEFAULT 0,
  issued      INTEGER NOT NULL DEFAULT 0,
  served      INTEGER NOT NULL DEFAULT 0,
  no_shows    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, branch_id)
);
-- Append-only audit trail of sensitive admin/owner actions (suspend, plan change, reset-PIN,
-- LINE-config change, PDPA export/erasure). For multi-tenant trust + incident forensics.
-- Never stores secrets — only a short, non-sensitive detail context string.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,              -- epoch ms
  tenant_id INTEGER NOT NULL DEFAULT 1,    -- the tenant the action targets
  actor     TEXT NOT NULL DEFAULT '',      -- 'admin' | 'owner:<staffId>' | 'system'
  action    TEXT NOT NULL,                 -- e.g. 'tenant.suspend', 'line.config'
  detail    TEXT NOT NULL DEFAULT '',      -- short non-secret context
  ip        TEXT NOT NULL DEFAULT ''
);
-- ============ Multi-branch POS foundation (Phase 0) ============
-- A tenant = one restaurant business (the SaaS account). Every tenant-owned row
-- carries tenant_id (default 1). YO-Dee = tenant 1. Enforcement arrives with the
-- tenant-scoped session in Phase 1; this is additive insurance so we never repaint.
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  plan_name  TEXT NOT NULL DEFAULT 'free',   -- subscription plan (billing wired later)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Staff identity + roles. PIN is scrypt-hashed (server/auth.js). role ∈ owner|manager|cashier.
CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'cashier',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Which branches a (non-owner) staffer may access. Owner role bypasses this = all branches.
CREATE TABLE IF NOT EXISTS staff_branches (
  staff_id  INTEGER NOT NULL REFERENCES staff(id),
  branch_id INTEGER NOT NULL REFERENCES stores(id),
  PRIMARY KEY (staff_id, branch_id)
);
-- Per-branch OVERRIDES on the global menu_items catalog. Absent row = item enabled at
-- catalog price/soldout. A row lets a branch disable, reprice, or sold-out an item.
CREATE TABLE IF NOT EXISTS branch_menu (
  branch_id      INTEGER NOT NULL REFERENCES stores(id),
  item_id        INTEGER NOT NULL REFERENCES menu_items(id),
  enabled        INTEGER NOT NULL DEFAULT 1,
  price_override REAL,
  soldout        INTEGER NOT NULL DEFAULT 0,
  sort           INTEGER,
  PRIMARY KEY (branch_id, item_id)
);
-- Append-only audit / transaction trail (feeds transaction-log + void/refund/discount/
-- payment reports + reconciliation). type ∈ order_created|paid|void|refund|discount|...
CREATE TABLE IF NOT EXISTS sale_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER,
  ticket_id INTEGER,
  order_id  INTEGER,
  type      TEXT NOT NULL,
  amount    REAL NOT NULL DEFAULT 0,
  actor     INTEGER,                 -- staff.id who performed it (null = customer/system)
  meta      TEXT,                    -- small JSON blob (reason, method, etc.)
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sale_events_branch_at ON sale_events(branch_id, at);
-- LINE customers — order history for reorder suggestions next visit.
CREATE TABLE IF NOT EXISTS customers (
  line_user_id  TEXT PRIMARY KEY,
  name          TEXT,
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_order_at TEXT,
  order_count   INTEGER NOT NULL DEFAULT 0,
  fav_items     TEXT                 -- small JSON: [{name, qty}] most-ordered
);
-- ============ Price tiers + sales channels (multi-price per product) ============
-- A named price level (e.g. หน้าร้าน / เดลิเวอรี่). markup_pct is the default uplift
-- over the base price when no explicit per-item price exists for the tier.
CREATE TABLE IF NOT EXISTS price_tiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,   -- 1 = the storefront/base tier
  markup_pct REAL NOT NULL DEFAULT 0,      -- default % uplift over base for this tier
  sort       INTEGER NOT NULL DEFAULT 0
);
-- A sales channel maps to a price tier and carries the platform commission (for P&L).
CREATE TABLE IF NOT EXISTS channels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  tier_id        INTEGER REFERENCES price_tiers(id),
  commission_pct REAL NOT NULL DEFAULT 0,  -- platform takes this % (Grab/LINE MAN/Shopee ~30)
  active         INTEGER NOT NULL DEFAULT 1,
  sort           INTEGER NOT NULL DEFAULT 0
);
-- Explicit price book: exact price for an item at a tier (optionally per branch).
-- branch_id 0 = applies to all branches; a branch-specific row overrides the 0 row.
CREATE TABLE IF NOT EXISTS item_prices (
  item_id   INTEGER NOT NULL REFERENCES menu_items(id),
  tier_id   INTEGER NOT NULL REFERENCES price_tiers(id),
  branch_id INTEGER NOT NULL DEFAULT 0,
  price     REAL NOT NULL,
  PRIMARY KEY (item_id, tier_id, branch_id)
);
-- Cash drawer sessions for end-of-day cash-up (Z-report): open float -> expected
-- vs counted -> over/short.
CREATE TABLE IF NOT EXISTS cash_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id     INTEGER NOT NULL DEFAULT 1,
  opened_by     INTEGER,
  opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
  open_float    REAL NOT NULL DEFAULT 0,
  closed_by     INTEGER,
  closed_at     TEXT,
  counted_cash  REAL,
  expected_cash REAL,
  over_short    REAL,
  note          TEXT
);
-- Inventory: raw materials/ingredients + a movement log (purchases / stock counts / usage).
CREATE TABLE IF NOT EXISTS ingredients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL DEFAULT 1,
  branch_id     INTEGER,                       -- null = shared across branches
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'หน่วย', -- กล่อง/ขวด/กก./ลิตร/ถุง ...
  stock_qty     REAL NOT NULL DEFAULT 0,       -- current on-hand quantity
  avg_cost      REAL NOT NULL DEFAULT 0,       -- weighted-average cost per unit
  low_threshold REAL NOT NULL DEFAULT 0,       -- alert when stock_qty <= this
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  branch_id     INTEGER,
  kind          TEXT NOT NULL,                 -- purchase | adjust | use | waste
  qty           REAL NOT NULL,                 -- signed change applied to stock
  cost          REAL,                          -- total cost of a purchase (optional)
  note          TEXT,
  actor         INTEGER,
  at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_ing ON stock_moves(ingredient_id, at);
-- Recipe / bill-of-materials: how much of each ingredient one unit of a menu item uses.
-- Drives AUTO stock deduction when a sale is paid. Empty by default → no deduction
-- (dormant) until the owner defines recipes, so existing behaviour is unchanged.
CREATE TABLE IF NOT EXISTS recipes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  qty           REAL NOT NULL DEFAULT 0,        -- ingredient units consumed per 1 menu unit
  UNIQUE(menu_item_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_menu ON recipes(menu_item_id);
-- Payment tenders (HOW money is collected). Each is a distinct settlement channel so the
-- owner can reconcile each day's total against what each app/bank actually pays out.
-- fee_pct is usually 0 (shop keeps 100%); reserved for a platform fee (e.g. LINE Pay).
CREATE TABLE IF NOT EXISTS tenders (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT NOT NULL UNIQUE,             -- cash | 6040 | kplus | online | linepay
  label   TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT 'counter',  -- counter (cashier collects) | online (customer app)
  fee_pct REAL NOT NULL DEFAULT 0,          -- platform fee %, 0 = shop keeps all
  active  INTEGER NOT NULL DEFAULT 1,
  sort    INTEGER NOT NULL DEFAULT 0
);
-- Payment slips a customer attaches for the cashier to verify manually (works without SlipOK).
-- One per order (latest wins). Stored as a data: URL; only written when a slip is attached.
CREATE TABLE IF NOT EXISTS slips (
  order_id  INTEGER PRIMARY KEY,
  ticket_id INTEGER,
  image     TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Loyalty: our own points system (LINE Reward Cards can't be awarded via API). A customer
-- earns points when a LINE order is paid; redeems them for rewards. Balance lives on
-- customers.points; loyalty_moves is the append-only ledger (earn +, redeem −).
CREATE TABLE IF NOT EXISTS loyalty_moves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_key TEXT NOT NULL,                  -- = customers.line_user_id
  kind         TEXT NOT NULL,                  -- earn | redeem | adjust
  points       INTEGER NOT NULL,              -- signed: earn>0, redeem<0
  order_id     INTEGER,                        -- the paid order that earned it (earn only)
  note         TEXT,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loyalty_moves_key ON loyalty_moves(customer_key, at);
CREATE TABLE IF NOT EXISTS rewards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  cost_points INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);
`);

// ---- Lightweight migrations for DBs created before these columns existed ----
// node:sqlite throws "duplicate column name" if the column is already there; ignore.
for (const stmt of [
  `ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'cashier'`,
  `ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'`,
  `ALTER TABLE orders ADD COLUMN paid_at TEXT`,
  `ALTER TABLE menu_items ADD COLUMN soldout INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE stores ADD COLUMN is_open INTEGER NOT NULL DEFAULT 1`,
  // --- Phase 0 multi-branch POS columns (all additive / nullable-safe) ---
  `ALTER TABLE stores ADD COLUMN code TEXT`,
  // --- Per-branch profile + opening hours (additive) ---
  `ALTER TABLE stores ADD COLUMN address TEXT`,
  `ALTER TABLE stores ADD COLUMN phone TEXT`,
  `ALTER TABLE stores ADD COLUMN hours_open TEXT`,
  `ALTER TABLE stores ADD COLUMN hours_close TEXT`,
  `ALTER TABLE stores ADD COLUMN hours_days TEXT`,
  `ALTER TABLE orders ADD COLUMN branch_id INTEGER`,         // = tickets.store_id (denormalized)
  `ALTER TABLE orders ADD COLUMN discount REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN discount_reason TEXT`,
  `ALTER TABLE orders ADD COLUMN payment_method TEXT`,       // cash|promptpay|slip|other
  `ALTER TABLE orders ADD COLUMN void_kind TEXT`,            // void (unpaid) | refund (paid)
  `ALTER TABLE orders ADD COLUMN void_reason TEXT`,
  `ALTER TABLE orders ADD COLUMN voided_at TEXT`,
  `ALTER TABLE orders ADD COLUMN created_by INTEGER`,        // staff.id
  `ALTER TABLE orders ADD COLUMN paid_by INTEGER`,
  `ALTER TABLE orders ADD COLUMN voided_by INTEGER`,
  `ALTER TABLE orders ADD COLUMN channel_id INTEGER`,       // which sales channel the order came through
  `ALTER TABLE order_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'base'`, // base | addon
  `ALTER TABLE customers ADD COLUMN birthday TEXT`,        // 'YYYY-MM-DD' (optional) → birthday free drink
  `ALTER TABLE customers ADD COLUMN referral_code TEXT`,   // this customer's own invite code (YD…)
  `ALTER TABLE customers ADD COLUMN referred_by TEXT`,     // line_user_id of the friend who invited them
  `ALTER TABLE rewards ADD COLUMN image TEXT`,             // optional reward photo for the LIFF rewards list
  `ALTER TABLE tickets ADD COLUMN customer_key TEXT`,      // loyalty key for non-LINE (Pkg 1) walk-ins, e.g. 'tel:08...'
  // --- Multi-tenant SaaS insurance: tenant_id on every tenant-owned table (default 1) ---
  `ALTER TABLE stores ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE staff ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE menu_items ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE price_tiers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE channels ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE customers ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  // Loyalty points balance (current) + lifetime (never decremented; for tiers/stats).
  `ALTER TABLE customers ADD COLUMN points INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE customers ADD COLUMN lifetime_points INTEGER NOT NULL DEFAULT 0`,
  // Customer-initiated refund request (paid online, can't come to the shop).
  `ALTER TABLE orders ADD COLUMN refund_requested INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN refund_note TEXT`,
  // 'plan' is a libSQL reserved token (returns key as 'PLAN'); rename any already-created
  // column. Throws (and is ignored) on fresh DBs where the column is already plan_name.
  `ALTER TABLE tenants RENAME COLUMN plan TO plan_name`,
  // --- SaaS self-registration: a tenant carries its routing slug + brand config + package ---
  `ALTER TABLE tenants ADD COLUMN slug TEXT`,
  `ALTER TABLE tenants ADD COLUMN owner_email TEXT`,
  `ALTER TABLE tenants ADD COLUMN brand_name TEXT`,
  `ALTER TABLE tenants ADD COLUMN brand_short TEXT`,
  `ALTER TABLE tenants ADD COLUMN brand_theme TEXT`,
  `ALTER TABLE tenants ADD COLUMN brand_unit TEXT`,
  `ALTER TABLE tenants ADD COLUMN brand_logo TEXT`,
  `ALTER TABLE tenants ADD COLUMN package TEXT NOT NULL DEFAULT 'line'`,
  `ALTER TABLE tenants ADD COLUMN domain TEXT`,   // optional custom domain → serves the brand at root
  // --- Self-service billing (Omise subscription) ---
  `ALTER TABLE tenants ADD COLUMN omise_customer_id TEXT`,  // saved card → recurring charge
  `ALTER TABLE tenants ADD COLUMN plan_until TEXT`,         // pro paid through this datetime (UTC)
  `ALTER TABLE tenants ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tenants ADD COLUMN plan_interval TEXT NOT NULL DEFAULT 'month'`,  // 'month' | 'year' (renewal cadence)
  // --- Growth: free trial + founder lock-in + referral ---
  `ALTER TABLE tenants ADD COLUMN founder INTEGER NOT NULL DEFAULT 0`,   // first-N shops lock founder price
  `ALTER TABLE tenants ADD COLUMN referral_code TEXT`,                   // this tenant's own invite code
  `ALTER TABLE tenants ADD COLUMN referred_by TEXT`,                     // referral_code that invited them
  `ALTER TABLE tenants ADD COLUMN owner_pass_hash TEXT`,                 // owner email-login password (scrypt; optional)
  // Tenant-global config tables that were missing a tenant_id (default 1 = existing business).
  `ALTER TABLE ingredients ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE rewards ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`,
  // Idempotency key per bill: a retried create+pay with the same token returns the SAME
  // order instead of creating a duplicate (lets the cashier UI auto-retry a lost request safely).
  `ALTER TABLE tickets ADD COLUMN client_token TEXT`,
  // Queue-first model: timestamp when a queue number was actually issued (at payment under
  // pay-first, at order creation under queue-first) → accurate "issued today" reporting.
  `ALTER TABLE tickets ADD COLUMN numbered_at TEXT`,
  // Queue-first cancellation flow: making_at = when the cashier committed to making it (locks the
  // customer's self-cancel); cancel_requested = a LINE customer asked to cancel (sticky on the board).
  `ALTER TABLE tickets ADD COLUMN making_at TEXT`,
  `ALTER TABLE tickets ADD COLUMN cancel_requested TEXT`,
  // Historical P&L: snapshot the cost breakdown per archived day so past-day / monthly / yearly
  // P&L is exact (not reconstructed from today's settings, which may have changed since).
  `ALTER TABLE sales_history ADD COLUMN drink_sales REAL`,
  `ALTER TABLE sales_history ADD COLUMN topping_sales REAL`,
  `ALTER TABLE sales_history ADD COLUMN cogs REAL`,
  `ALTER TABLE sales_history ADD COLUMN opex REAL`,
  `ALTER TABLE sales_history ADD COLUMN waste_cost REAL`,
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}
// Index the idempotency token (created after the ALTER so it exists on migrated DBs too).
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_client_token ON tickets(client_token)'); } catch { /* ignore */ }
// Multi-tenant SaaS hot-path indexes — all post-migration (columns arrive via ALTER TABLE above).
// These dramatically speed up the tenant-scoped SELECT/JOIN patterns that run on every request.
for (const idx of [
  'CREATE INDEX IF NOT EXISTS idx_stores_tenant   ON stores(tenant_id)',
  'CREATE INDEX IF NOT EXISTS idx_staff_tenant    ON staff(tenant_id)',
  'CREATE INDEX IF NOT EXISTS idx_menu_tenant     ON menu_items(tenant_id, active)',
  'CREATE INDEX IF NOT EXISTS idx_ingredients_tenant ON ingredients(tenant_id)',
  'CREATE INDEX IF NOT EXISTS idx_orders_branch_date ON orders(branch_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id)',
]) { try { db.exec(idx); } catch { /* already exists */ } }
// Promo broadcasts (adopt-backlog #2): owner-composed LINE multicasts to owned customer base.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS promos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    message     TEXT NOT NULL,
    image_url   TEXT,
    link_url    TEXT,
    link_label  TEXT DEFAULT 'ดูโปรโมชั่น',
    send_at     INTEGER,           -- Unix timestamp; NULL = send immediately on creation
    status      TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sent | failed | cancelled
    sent_at     INTEGER,
    recipients  INTEGER,           -- how many LINE user IDs received it
    created_at  INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_promos_tenant_status ON promos(tenant_id, status, send_at);
  `);
} catch { /* already exists */ }

// Dunning email log — tracks which event was sent to which tenant to prevent duplicates.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS dunning_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    event       TEXT NOT NULL,   -- 'trial_7d' | 'trial_3d' | 'trial_1d' | 'lapsed'
    sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
    dry_run     INTEGER NOT NULL DEFAULT 0,
    to_email    TEXT,
    UNIQUE (tenant_id, event)    -- one send per event per tenant; reset on plan change
  );`);
} catch { /* already exists */ }

// Password-reset tokens — single-use, expire in 1 hour, raw token hashed (SHA-256) in the DB.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );`);
} catch { /* already exists */ }

// Email-change tokens — single-use, expire in 24 hours, SHA-256 hashed in DB.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS email_change_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    new_email   TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );`);
} catch { /* already exists */ }

// ---- One-time rebuild: give old single-branch sales_history a composite (date,branch_id)
// PK. SQLite can't alter a PK in place, so copy → drop → rename. Guarded by a column check
// so it runs at most once; existing rows are assigned to branch 1.
try {
  const cols = db.prepare(`PRAGMA table_info(sales_history)`).all();
  if (cols.length && !cols.some((c) => c.name === 'branch_id')) {
    db.exec(`
      CREATE TABLE sales_history_new (
        date TEXT NOT NULL, branch_id INTEGER NOT NULL DEFAULT 1,
        cups INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0,
        gross REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0,
        void_orders INTEGER NOT NULL DEFAULT 0, void_cups INTEGER NOT NULL DEFAULT 0,
        void_amount REAL NOT NULL DEFAULT 0, issued INTEGER NOT NULL DEFAULT 0,
        served INTEGER NOT NULL DEFAULT 0, no_shows INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, branch_id)
      );
      INSERT INTO sales_history_new (date, branch_id, cups, revenue, gross, net, void_orders, void_cups, void_amount, issued, served, no_shows)
        SELECT date, 1, cups, revenue, gross, net, void_orders, void_cups, void_amount, issued, served, no_shows FROM sales_history;
      DROP TABLE sales_history;
      ALTER TABLE sales_history_new RENAME TO sales_history;
    `);
  }
} catch (e) { console.error('[db] sales_history rebuild skipped:', e.message); }

// ---- One-time rebuild: customers gains composite PRIMARY KEY (line_user_id, tenant_id) so
// the same LINE user ordering at two different SaaS brands gets separate loyalty records.
// Guarded by pk-count: if only one column has pk>0 the old single-column PK is in use.
try {
  const pkCount = db.prepare(`PRAGMA table_info(customers)`).all().filter((c) => c.pk > 0).length;
  if (pkCount === 1) {
    db.exec(`
      CREATE TABLE customers_new (
        line_user_id    TEXT NOT NULL,
        tenant_id       INTEGER NOT NULL DEFAULT 1,
        name            TEXT,
        first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
        last_order_at   TEXT,
        order_count     INTEGER NOT NULL DEFAULT 0,
        fav_items       TEXT,
        birthday        TEXT,
        referral_code   TEXT,
        referred_by     TEXT,
        points          INTEGER NOT NULL DEFAULT 0,
        lifetime_points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (line_user_id, tenant_id)
      );
      INSERT INTO customers_new
        SELECT line_user_id, COALESCE(tenant_id,1), name, first_seen, last_order_at,
               order_count, fav_items, birthday, referral_code, referred_by,
               COALESCE(points,0), COALESCE(lifetime_points,0)
        FROM customers;
      DROP TABLE customers;
      ALTER TABLE customers_new RENAME TO customers;
      CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
    `);
    console.log('[db] customers table rebuilt with composite PK (line_user_id, tenant_id)');
  }
} catch (e) { console.error('[db] customers PK rebuild failed:', e.message); }

// ---- Backfill the new denormalized/derived columns on existing rows (idempotent) ----
try {
  // orders.branch_id ← the ticket's store_id
  db.exec(`UPDATE orders SET branch_id = (SELECT t.store_id FROM tickets t WHERE t.id = orders.ticket_id)
           WHERE branch_id IS NULL`);
  // order_items.kind ← 'addon' when the line matches a topping in the catalog, else 'base'
  db.exec(`UPDATE order_items SET kind = 'addon'
           WHERE kind = 'base' AND name IN (SELECT name FROM menu_items WHERE category = 'topping')`);
} catch (e) { console.error('[db] backfill skipped:', e.message); }

// ---- Seed tenant 1 (the current business) so tenant-scoped data has a home. ----
try {
  if (!db.prepare('SELECT COUNT(*) c FROM tenants').get().c) {
    db.prepare(`INSERT INTO tenants (name, plan_name) VALUES (?, 'free')`).run('YO-DEE Yogurt');
    console.log('[db] Seeded tenant 1.');
  }
  // Tenant 1 keeps a stable slug; brand fields stay NULL so it falls back to env (no change).
  db.prepare(`UPDATE tenants SET slug='main' WHERE id=1 AND (slug IS NULL OR slug='')`).run();
  // Slugs are the per-tenant routing key in SaaS mode → must be unique.
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)').run();
} catch (e) { console.error('[db] tenant seed skipped:', e.message); }

// ---- Seed a bootstrap OWNER staff so the new login works and you can't get locked out.
// PIN comes from OWNER_PIN (fallback CASHIER_PIN, fallback 1234). Idempotent: only when
// no owner exists yet. The legacy single CASHIER_PIN gate stays active until Phase 1.
try {
  const ownerExists = db.prepare(`SELECT COUNT(*) c FROM staff WHERE role='owner'`).get().c;
  if (!ownerExists) {
    const pin = process.env.OWNER_PIN || process.env.CASHIER_PIN || '1234';
    db.prepare(`INSERT INTO staff (name, pin_hash, role) VALUES (?,?, 'owner')`)
      .run('Owner', hashPin(pin));
    console.log('[db] Seeded bootstrap owner staff (role=owner).');
  }
  // Keep the bootstrap 'Owner' login in sync with the configured admin PIN, so a DB that
  // was seeded with a different/dev PIN (e.g. during testing) can't be logged into with
  // the stale PIN once per-staff login is active. (A separately-created owner is untouched.)
  const adminPin = process.env.OWNER_PIN || process.env.CASHIER_PIN || '1234';
  const boot = db.prepare(`SELECT id, pin_hash FROM staff WHERE role='owner' AND name='Owner' ORDER BY id LIMIT 1`).get();
  if (boot && !verifyPin(adminPin, boot.pin_hash)) {
    db.prepare('UPDATE staff SET pin_hash=? WHERE id=?').run(hashPin(adminPin), boot.id);
    console.log('[db] Reset bootstrap owner PIN to the configured admin PIN.');
  }
} catch (e) { console.error('[db] owner seed/heal skipped:', e.message); }

// ---- Seed default price tiers + channels (idempotent). markup_pct/commission are
// starting points the owner edits later; delivery prices stay = base until configured
// (no magic markup). ----
try {
  if (!db.prepare('SELECT COUNT(*) c FROM price_tiers').get().c) {
    db.prepare(`INSERT INTO price_tiers (name, is_default, markup_pct, sort) VALUES ('หน้าร้าน', 1, 0, 0)`).run();
    db.prepare(`INSERT INTO price_tiers (name, is_default, markup_pct, sort) VALUES ('เดลิเวอรี่', 0, 0, 1)`).run();
  }
  if (!db.prepare('SELECT COUNT(*) c FROM channels').get().c) {
    const storefront = db.prepare(`SELECT id FROM price_tiers WHERE is_default=1 LIMIT 1`).get()?.id;
    const delivery = db.prepare(`SELECT id FROM price_tiers WHERE is_default=0 ORDER BY sort LIMIT 1`).get()?.id;
    db.prepare(`INSERT INTO channels (name, tier_id, commission_pct, active, sort) VALUES ('หน้าร้าน', ?, 0, 1, 0)`).run(storefront);
    for (const [n, c] of [['Grab', 30], ['LINE MAN', 30], ['Shopee Food', 30]]) {
      db.prepare(`INSERT INTO channels (name, tier_id, commission_pct, active, sort) VALUES (?, ?, ?, 1, 1)`).run(n, delivery, c);
    }
    console.log('[db] Seeded default price tiers + channels.');
  }
} catch (e) { console.error('[db] tier/channel seed skipped:', e.message); }

// ---- Seed the payment tenders (idempotent). The owner's current 5 ways to get paid.
// 6040 = Krungthai "ไทยช่วยไทย พลัส" co-pay (shop receives 100%, tracked separately for
// reconciliation). All fee_pct = 0 for now; LINE Pay's fee can be set later if desired. ----
try {
  if (!db.prepare('SELECT COUNT(*) c FROM tenders').get().c) {
    const seed = [
      ['cash',    'เงินสด',                  'counter', 0],
      ['6040',    'ไทยช่วยไทย พลัส (เป๋าตัง)', 'counter', 1],
      ['kplus',   'K PLUS Shop',             'counter', 2],
      ['online',  'จ่ายออนไลน์ (QR)',         'online',  3],
      ['linepay', 'LINE Pay',                'online',  4],
    ];
    const ins = db.prepare(`INSERT INTO tenders (code, label, kind, active, sort) VALUES (?,?,?,1,?)`);
    for (const [code, label, kind, sort] of seed) ins.run(code, label, kind, sort);
    console.log('[db] Seeded payment tenders.');
  }
} catch (e) { console.error('[db] tender seed skipped:', e.message); }

// ---- Seed loyalty defaults (idempotent). Model = STAMP CARD: 1 stamp per drink cup;
// collect `stamps_per_reward` cups → 1 free drink (≤49฿). DISABLED by default so a prod
// cutover never auto-enables it; the UAT sandbox turns it on explicitly at boot (see index.js
// `!DURABLE` block), and the owner flips it on in prod via ⚙ จัดการ when ready. ----
try {
  const have = (k) => db.prepare('SELECT COUNT(*) c FROM settings WHERE key=?').get(k).c > 0;
  if (!have('loyalty:enabled')) db.prepare(`INSERT INTO settings(key,value) VALUES('loyalty:enabled','0')`).run();
  // Queue model: '0' = pay-first (number issued at payment) — the safe default so a prod cutover
  // keeps the current behavior; '1' = queue-first (number at order creation). UAT turns it on at boot.
  if (!have('queue:first')) db.prepare(`INSERT INTO settings(key,value) VALUES('queue:first','0')`).run();
  if (!have('loyalty:stamps_per_reward')) db.prepare(`INSERT INTO settings(key,value) VALUES('loyalty:stamps_per_reward','10')`).run();
  if (!have('loyalty:welcome_bonus')) db.prepare(`INSERT INTO settings(key,value) VALUES('loyalty:welcome_bonus','2')`).run();
  // SlipOK auto-verify + receipt printing: both prepared but OFF by default (owner enables later).
  if (!have('slip:auto')) db.prepare(`INSERT INTO settings(key,value) VALUES('slip:auto','0')`).run();
  if (!have('print:enabled')) db.prepare(`INSERT INTO settings(key,value) VALUES('print:enabled','0')`).run();
  // Starter raw materials (from the shop's Makro receipts) — only when the table is empty, so
  // it's a one-time editable seed. Stock left at 0 (owner counts/fills later); cost = price/unit.
  // Skipped for white-label blank brands (SEED=blank) — they add their own ingredients/reward.
  const BLANK_BRAND = (process.env.SEED || '').toLowerCase() === 'blank';
  if (!BLANK_BRAND && !db.prepare('SELECT COUNT(*) c FROM ingredients').get().c) {
    const ins = db.prepare('INSERT INTO ingredients (name, unit, avg_cost, low_threshold, stock_qty) VALUES (?,?,?,?,0)');
    for (const [n, u, c, lt] of [
      ['โยเกิร์ตรสธรรมชาติ (ดัชชี/เอ ไวร์)', 'กก.', 53, 2],
      ['โยเกิร์ตพร่องมันเนย (ดัชชี)', 'ลิตร', 56, 2],
      ['สตรอเบอร์รี่แช่แข็ง', 'กก.', 80, 1],
      ['มะม่วงน้ำดอกไม้', 'กก.', 95, 1],
      ['คิทแคท', 'ถุง', 115, 2],
      ['โอรีโอ แซนวิช', 'แพ็ก', 46, 2],
      ['น้ำเชื่อมเข้มข้น (มิตรผล)', 'ขวด', 85, 1],
    ]) ins.run(n, u, c, lt);
    console.log('[db] Seeded starter raw materials from Makro (stock 0, editable).');
  }
  if (!BLANK_BRAND && !db.prepare('SELECT COUNT(*) c FROM rewards').get().c) {
    db.prepare(`INSERT INTO rewards (name, cost_points, active, sort, image) VALUES ('เครื่องดื่มฟรี 1 แก้ว (ไม่เกิน 49฿)', 10, 1, 0, '/assets/menu/1-Original.png')`).run();
    console.log('[db] Seeded loyalty stamp card (disabled) + free-drink reward.');
  }
} catch (e) { console.error('[db] loyalty seed skipped:', e.message); }

// Settings are per-tenant. To avoid a risky PK migration on the live settings table, tenant 1
// (the original business) keeps BARE keys exactly as before, and other tenants are namespaced
// with a "t<id>:" prefix. So single-tenant behaviour is byte-for-byte unchanged.
function settingKey(key, tenantId) {
  const t = tenantId || currentTenantId();
  return t === 1 ? key : `t${t}:${key}`;
}
export function getSetting(key, fallback = null, tenantId) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey(key, tenantId));
  return row ? row.value : fallback;
}
export function setSetting(key, value, tenantId) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(settingKey(key, tenantId), String(value));
}

// ---------- Tenant registry (SaaS) ----------
export function getTenant(id) {
  return db.prepare('SELECT * FROM tenants WHERE id=?').get(Number(id) || 0) || null;
}
export function getTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug=?').get(String(slug || '').toLowerCase()) || null;
}
export function getTenantByDomain(host) {
  const h = String(host || '').toLowerCase().trim();
  return h ? (db.prepare('SELECT * FROM tenants WHERE domain=?').get(h) || null) : null;
}
// Platform-owned hostnames a tenant must NEVER be allowed to claim: doing so would poison the
// Host-header → tenant resolution (see index.js) and let one tenant hijack the platform root /
// landing / signup / another visitor's traffic. Derived from the deploy's own base URLs.
const hostOf = (u) => String(u || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
const RESERVED_DOMAINS = new Set(
  [process.env.SAAS_BASE, process.env.PUBLIC_BASE_URL, process.env.BASE_URL]
    .map(hostOf).filter(Boolean)
    .flatMap((h) => [h, h.startsWith('www.') ? h.slice(4) : 'www.' + h])
    .concat(['localhost', '127.0.0.1'])
);
/** Map (or clear) a tenant's custom domain. Pass '' to remove. Validated + unique + not reserved. */
export function setTenantDomain(tenantId, domain) {
  const d = String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error('bad_domain');
  if (d && RESERVED_DOMAINS.has(d)) throw new Error('reserved_domain');   // can't claim the platform's own host
  if (d) { const ex = db.prepare('SELECT id FROM tenants WHERE domain=? AND id<>?').get(d, tenantId); if (ex) throw new Error('domain_taken'); }
  db.prepare('UPDATE tenants SET domain=? WHERE id=?').run(d || null, tenantId);
  return getTenant(tenantId);
}
export function listTenants() {
  return db.prepare('SELECT id, name, slug, owner_email, package, plan_name, active, created_at FROM tenants ORDER BY id').all();
}
/** Append a sensitive-action row to the audit trail. Best-effort: never throws into a request
 *  path (a logging failure must not break the action it records). `detail` is truncated + must
 *  never carry a secret (tokens/PINs/passwords). */
export function logAudit({ tenantId = 1, actor = 'system', action, detail = '', ip = '' } = {}) {
  try {
    if (!action) return false;
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    db.prepare('INSERT INTO audit_log (at, tenant_id, actor, action, detail, ip) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), Number(tenantId) || 1, String(actor).slice(0, 60), String(action).slice(0, 60), String(d).slice(0, 300), String(ip).slice(0, 60));
    return true;
  } catch { return false; }
}
/** Recent audit events, newest first. Optionally scope to one tenant. */
export function listAudit({ tenantId = null, limit = 200 } = {}) {
  const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
  return tenantId
    ? db.prepare('SELECT id, at, tenant_id, actor, action, detail, ip FROM audit_log WHERE tenant_id=? ORDER BY id DESC LIMIT ?').all(Number(tenantId), lim)
    : db.prepare('SELECT id, at, tenant_id, actor, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT ?').all(lim);
}
/** Resolve a free slug derived from the desired name (adds -2, -3… on collision). */
function uniqueSlug(desired) {
  let base = slugify(desired), s = base, n = 1;
  while (db.prepare('SELECT 1 FROM tenants WHERE slug=?').get(s)) { n += 1; s = `${base}-${n}`; }
  return s;
}
/** Create a tenant (a new brand). Returns the row. Brand fields drive the white-label theming. */
export function createTenant({ name, ownerEmail = null, pkg = 'line', slug = null, brandShort = null, brandTheme = null, brandUnit = null, brandLogo = null } = {}) {
  const nm = String(name || '').trim().slice(0, 80);
  if (!nm) throw new Error('name_required');
  const s = uniqueSlug(slug || nm);
  const pack = pkg === 'pos' ? 'pos' : 'line';
  // First N real shops (id>1) lock the founder price for life.
  const FOUNDER_SLOTS = Math.max(0, parseInt(process.env.FOUNDER_SLOTS || '50', 10) || 50);
  const realSoFar = db.prepare('SELECT COUNT(*) c FROM tenants WHERE id>1').get().c;
  const founder = realSoFar < FOUNDER_SLOTS ? 1 : 0;
  const r = db.prepare(
    `INSERT INTO tenants (name, plan_name, active, slug, owner_email, brand_name, brand_short, brand_theme, brand_unit, brand_logo, package, founder)
     VALUES (?, 'free', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(nm, s, ownerEmail, nm, brandShort, brandTheme, brandUnit, brandLogo, pack, founder);
  const id = Number(r.lastInsertRowid);
  // Each tenant gets a short invite code (e.g. R-3K).
  db.prepare('UPDATE tenants SET referral_code=? WHERE id=?').run('R' + id.toString(36).toUpperCase(), id);
  return getTenant(id);
}
/** Start a free trial: full Pro for `days` (no card). Auto-lapses to free via tenantPlan grace. */
export function startTrial(tenantId, days = 60) {
  const until = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare("UPDATE tenants SET plan_name='pro', plan_interval='month', plan_until=?, auto_renew=0 WHERE id=?").run(until, tenantId);
  return until;
}
export function getTenantByReferral(code) {
  return db.prepare('SELECT * FROM tenants WHERE referral_code=?').get(String(code || '').toUpperCase().trim()) || null;
}
// ---------- Owner account login (email / Google) — finds which shop(s) an email owns ----------
export function setOwnerPassword(tenantId, password) {
  if (!password) return; db.prepare('UPDATE tenants SET owner_pass_hash=? WHERE id=?').run(hashPin(String(password)), tenantId);
}
export function updateOwnerEmail(tenantId, email) {
  const e = String(email || '').trim().toLowerCase();
  db.prepare('UPDATE tenants SET owner_email=? WHERE id=?').run(e || null, Number(tenantId));
}
/** Email+password → the active shops that email owns with a matching password. */
export function ownerLoginMatches(email, password) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !password) return [];
  return db.prepare('SELECT id, slug, name, owner_pass_hash FROM tenants WHERE active=1 AND lower(owner_email)=?').all(e)
    .filter((r) => r.owner_pass_hash && verifyPin(String(password), r.owner_pass_hash))
    .map((r) => ({ tenantId: r.id, slug: r.slug, name: r.name }));
}
/** Verified email (e.g. via Google) → all active shops that email owns. */
export function ownerTenantsByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  return db.prepare('SELECT id, slug, name FROM tenants WHERE active=1 AND lower(owner_email)=?').all(e)
    .map((r) => ({ tenantId: r.id, slug: r.slug, name: r.name }));
}
export function ownerStaffId(tenantId) {
  const s = db.prepare("SELECT id FROM staff WHERE tenant_id=? AND role='owner' AND active=1 ORDER BY id LIMIT 1").get(tenantId);
  return s ? s.id : null;
}
/** Apply a referral at signup: extend BOTH the new tenant and the referrer's paid-through by
 *  `days`. No self-referral, once only. Returns true if applied. */
export function applyTenantReferral(newTenantId, code, days = 30) {
  const ref = getTenantByReferral(code);
  const me = getTenant(newTenantId);
  if (!ref || !me || ref.id === newTenantId || me.referred_by) return false;
  const ext = (t) => { const base = t.plan_until && t.plan_until > new Date().toISOString() ? t.plan_until : new Date().toISOString();
    const until = new Date(new Date(base).getTime() + days * 86400000).toISOString();
    db.prepare("UPDATE tenants SET plan_name=CASE WHEN plan_name='free' THEN 'pro' ELSE plan_name END, plan_until=? WHERE id=?").run(until, t.id); };
  ext(me); ext(ref);
  db.prepare('UPDATE tenants SET referred_by=? WHERE id=?').run(ref.referral_code, newTenantId);
  return true;
}
/** Platform referral overview for the admin console: per-tenant invite code, who referred them,
 *  and how many they've referred — plus headline growth metrics. Read-only. */
export function referralStats() {
  const all = db.prepare('SELECT id, name, slug, referral_code, referred_by, created_at FROM tenants ORDER BY id').all();
  const byCode = new Map(all.map((t) => [t.referral_code, t]));
  const referredCount = {};
  for (const t of all) { if (t.referred_by) referredCount[t.referred_by] = (referredCount[t.referred_by] || 0) + 1; }
  const rows = all.map((t) => ({
    id: t.id, name: t.name, slug: t.slug, createdAt: t.created_at,
    referralCode: t.referral_code || null,
    referredByName: t.referred_by ? (byCode.get(t.referred_by)?.name || t.referred_by) : null,
    referredCount: referredCount[t.referral_code] || 0,
  }));
  const real = rows.filter((r) => r.id > 1);                 // exclude the primary YO-DEE tenant from growth %
  const viaReferral = real.filter((r) => r.referredByName).length;
  const topReferrers = rows.filter((r) => r.referredCount > 0).sort((a, b) => b.referredCount - a.referredCount).slice(0, 5)
    .map((r) => ({ name: r.name, count: r.referredCount }));
  return {
    summary: { tenants: real.length, viaReferral, referralPct: real.length ? Math.round((viaReferral / real.length) * 100) : 0, topReferrers },
    rows,
  };
}
// ---------- PDPA: data portability + erasure ----------
/** Full export of a tenant's business data (data portability). Owner-gated at the route. */
export function exportTenant(tenantId) {
  const stores = db.prepare('SELECT * FROM stores WHERE tenant_id=?').all(tenantId);
  const ids = stores.map((s) => s.id);
  const inStores = ids.length ? `(${ids.join(',')})` : '(-1)';   // ids are ints → safe
  return {
    exportedAt: new Date().toISOString(),
    tenant: getTenant(tenantId),
    stores,
    zones: db.prepare(`SELECT * FROM zones WHERE store_id IN ${inStores}`).all(),
    menu: db.prepare('SELECT * FROM menu_items WHERE tenant_id=?').all(tenantId),
    customers: db.prepare('SELECT * FROM customers WHERE tenant_id=?').all(tenantId),
    ingredients: db.prepare('SELECT * FROM ingredients WHERE tenant_id=?').all(tenantId),
    rewards: db.prepare('SELECT * FROM rewards WHERE tenant_id=?').all(tenantId),
    tickets: db.prepare(`SELECT * FROM tickets WHERE zone_id IN (SELECT id FROM zones WHERE store_id IN ${inStores})`).all(),
    orders: db.prepare(`SELECT * FROM orders WHERE branch_id IN ${inStores}`).all(),
  };
}
/** PDPA erasure of ONE customer's personal data (right to be forgotten). Removes the customer +
 *  loyalty rows and anonymises their tickets. Accepts a phone or a raw customer key. */
export function forgetCustomer(tenantId, { phone = null, key = null } = {}) {
  let k = key;
  if (!k && phone) { const d = String(phone).replace(/\D/g, ''); if (d.length < 9 || d.length > 10) throw new Error('bad_phone'); k = (tenantId === 1 ? '' : `t${tenantId}:`) + 'tel:' + d; }
  if (!k) throw new Error('phone_or_key_required');
  const c = db.prepare('SELECT 1 FROM customers WHERE line_user_id=? AND tenant_id=?').get(k, tenantId);
  db.transaction(() => {
    db.prepare('DELETE FROM loyalty_moves WHERE customer_key=?').run(k);
    db.prepare('DELETE FROM customers WHERE line_user_id=? AND tenant_id=?').run(k, tenantId);
    db.prepare(`UPDATE tickets SET customer_name=NULL, customer_key=NULL, line_user_id=NULL
      WHERE (customer_key=? OR line_user_id=?)
        AND store_id IN (SELECT id FROM stores WHERE tenant_id=?)`).run(k, k, tenantId);
  })();
  return { erased: true, found: !!c, key: k };
}

/** PDPA tenant-level erasure / account close-out: HARD-delete a tenant and EVERY row it owns,
 *  across all tenant-scoped tables (directly via tenant_id, or via its stores/zones/orders/items/
 *  ingredients/customers). Refuses tenant 1 (YO-DEE primary). Runs in one transaction so it's all
 *  or nothing. Returns per-table delete counts. Export first (exportTenant) — this is irreversible.
 *  Tenders are GLOBAL (shared) and never touched. `t` is validated to an int, so the interpolation
 *  below carries no injection risk. */
export function deleteTenant(tenantId) {
  const t = Number(tenantId);
  if (!Number.isInteger(t) || t <= 1) throw new Error('cannot_delete_primary');
  if (!getTenant(t)) throw new Error('not_found');
  const counts = {};
  const del = (label, sql) => { counts[label] = db.prepare(sql).run().changes || 0; };
  const stores = `(SELECT id FROM stores WHERE tenant_id=${t})`;
  const zones = `(SELECT id FROM zones WHERE store_id IN ${stores})`;
  const orders = `(SELECT id FROM orders WHERE branch_id IN ${stores})`;
  const tickets = `(SELECT id FROM tickets WHERE store_id IN ${stores})`;
  const items = `(SELECT id FROM menu_items WHERE tenant_id=${t})`;
  const ings = `(SELECT id FROM ingredients WHERE tenant_id=${t})`;
  const tiers = `(SELECT id FROM price_tiers WHERE tenant_id=${t})`;
  const custs = `(SELECT line_user_id FROM customers WHERE tenant_id=${t})`;
  const staff = `(SELECT id FROM staff WHERE tenant_id=${t})`;
  db.transaction(() => {
    // children first (FK-safe even with foreign_keys=ON)
    del('order_items', `DELETE FROM order_items WHERE order_id IN ${orders}`);
    del('slips', `DELETE FROM slips WHERE order_id IN ${orders} OR ticket_id IN ${tickets}`);
    del('loyalty_moves', `DELETE FROM loyalty_moves WHERE customer_key IN ${custs} OR order_id IN ${orders}`);
    del('sale_events', `DELETE FROM sale_events WHERE branch_id IN ${stores} OR order_id IN ${orders} OR ticket_id IN ${tickets}`);
    del('orders', `DELETE FROM orders WHERE branch_id IN ${stores}`);
    del('daily_stats', `DELETE FROM daily_stats WHERE zone_id IN ${zones}`);
    del('tickets', `DELETE FROM tickets WHERE store_id IN ${stores}`);
    del('zones', `DELETE FROM zones WHERE store_id IN ${stores}`);
    del('recipes', `DELETE FROM recipes WHERE menu_item_id IN ${items} OR ingredient_id IN ${ings}`);
    del('branch_menu', `DELETE FROM branch_menu WHERE branch_id IN ${stores} OR item_id IN ${items}`);
    del('item_prices', `DELETE FROM item_prices WHERE item_id IN ${items} OR tier_id IN ${tiers} OR branch_id IN ${stores}`);
    del('stock_moves', `DELETE FROM stock_moves WHERE ingredient_id IN ${ings} OR branch_id IN ${stores}`);
    del('cash_sessions', `DELETE FROM cash_sessions WHERE branch_id IN ${stores}`);
    del('sales_history', `DELETE FROM sales_history WHERE branch_id IN ${stores}`);
    del('staff_branches', `DELETE FROM staff_branches WHERE branch_id IN ${stores} OR staff_id IN ${staff}`);
    // roots
    del('menu_items', `DELETE FROM menu_items WHERE tenant_id=${t}`);
    del('ingredients', `DELETE FROM ingredients WHERE tenant_id=${t}`);
    del('rewards', `DELETE FROM rewards WHERE tenant_id=${t}`);
    del('customers', `DELETE FROM customers WHERE tenant_id=${t}`);
    del('channels', `DELETE FROM channels WHERE tenant_id=${t}`);
    del('price_tiers', `DELETE FROM price_tiers WHERE tenant_id=${t}`);
    del('staff', `DELETE FROM staff WHERE tenant_id=${t}`);
    del('stores', `DELETE FROM stores WHERE tenant_id=${t}`);
    del('settings', `DELETE FROM settings WHERE key LIKE 't${t}:%'`);
    del('audit_log', `DELETE FROM audit_log WHERE tenant_id=${t}`);
    del('promos', `DELETE FROM promos WHERE tenant_id=${t}`);
    del('tenants', `DELETE FROM tenants WHERE id=${t}`);
  })();
  return { deleted: true, tenantId: t, counts };
}

/** Seed the per-tenant defaults a brand-new tenant needs to be usable: price tiers + sales
 *  channels (tenders are shared globally). Idempotent. Settings use fallbacks so need no seed. */
export function seedTenantDefaults(tenantId) {
  const t = Number(tenantId) || 0;
  if (!t) return;
  if (!db.prepare('SELECT COUNT(*) c FROM price_tiers WHERE tenant_id=?').get(t).c) {
    db.prepare(`INSERT INTO price_tiers (name, is_default, markup_pct, sort, tenant_id) VALUES ('หน้าร้าน', 1, 0, 0, ?)`).run(t);
    db.prepare(`INSERT INTO price_tiers (name, is_default, markup_pct, sort, tenant_id) VALUES ('เดลิเวอรี่', 0, 0, 1, ?)`).run(t);
  }
  if (!db.prepare('SELECT COUNT(*) c FROM channels WHERE tenant_id=?').get(t).c) {
    const storefront = db.prepare(`SELECT id FROM price_tiers WHERE is_default=1 AND tenant_id=? LIMIT 1`).get(t)?.id;
    const delivery = db.prepare(`SELECT id FROM price_tiers WHERE is_default=0 AND tenant_id=? ORDER BY sort LIMIT 1`).get(t)?.id;
    db.prepare(`INSERT INTO channels (name, tier_id, commission_pct, active, sort, tenant_id) VALUES ('หน้าร้าน', ?, 0, 1, 0, ?)`).run(storefront, t);
    for (const [n, c] of [['Grab', 30], ['LINE MAN', 30], ['Shopee Food', 30]]) {
      db.prepare(`INSERT INTO channels (name, tier_id, commission_pct, active, sort, tenant_id) VALUES (?, ?, ?, 1, 1, ?)`).run(n, delivery, c, t);
    }
  }
}

/** Edit a tenant's brand (name/short/theme/unit/logo). Logo is a data: URL or /path. Only the
 *  fields provided are changed. Returns the refreshed brand. */
export function updateTenantBrand(tenantId, { name, short, theme, unit, logo } = {}) {
  const t = getTenant(tenantId);
  if (!t) throw new Error('tenant_not_found');
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('brand_name=?'); vals.push(String(name || '').slice(0, 80) || t.name); }
  if (short !== undefined) { sets.push('brand_short=?'); vals.push(String(short || '').slice(0, 24) || null); }
  if (theme !== undefined) { sets.push('brand_theme=?'); vals.push(/^#[0-9a-fA-F]{6}$/.test(theme || '') ? theme : null); }
  if (unit !== undefined) { sets.push('brand_unit=?'); vals.push(String(unit || '').slice(0, 16) || null); }
  if (logo !== undefined) { sets.push('brand_logo=?'); vals.push(logo ? String(logo).slice(0, 400000) : null); } // data URL ok
  if (sets.length) { vals.push(tenantId); db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id=?`).run(...vals); }
  return getTenant(tenantId);
}

// ---------- Password-reset tokens ----------
/** Create a single-use reset token for a tenant (1-hour TTL). Returns the raw token. */
export function createResetToken(tenantId) {
  const raw = randomBytes(32).toString('hex');  // 64-char hex — 256 bits of entropy
  const hash = createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  // One active token per tenant — replace any existing one.
  db.prepare('DELETE FROM password_reset_tokens WHERE tenant_id=?').run(tenantId);
  db.prepare('INSERT INTO password_reset_tokens (tenant_id, token_hash, expires_at) VALUES (?,?,?)').run(tenantId, hash, expires);
  return raw;
}
/** Validate a raw token. Returns the tenant_id or null (expired / used / not found). */
export function validateResetToken(raw) {
  if (!raw) return null;
  const hash = createHash('sha256').update(String(raw)).digest('hex');
  const row = db.prepare('SELECT tenant_id, expires_at, used FROM password_reset_tokens WHERE token_hash=?').get(hash);
  if (!row || row.used || new Date(row.expires_at) < new Date()) return null;
  return row.tenant_id;
}
/** Consume (mark used) a valid token, then set the new password. Returns false if invalid. */
export function consumeResetToken(raw, newPassword) {
  const tenantId = validateResetToken(raw);
  if (!tenantId) return false;
  const hash = createHash('sha256').update(String(raw)).digest('hex');
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE token_hash=?').run(hash);
  setOwnerPassword(tenantId, String(newPassword));
  return true;
}

/** Create an email-change verification token for tenantId → newEmail. Returns the raw token. */
export function createEmailChangeToken(tenantId, newEmail) {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM email_change_tokens WHERE tenant_id=?').run(tenantId);
  db.prepare('INSERT INTO email_change_tokens (tenant_id, new_email, token_hash, expires_at) VALUES (?,?,?,?)').run(tenantId, newEmail, hash, expires);
  return raw;
}
/** Consume a raw email-change token — applies the email update. Returns { tenantId, newEmail } or null. */
export function consumeEmailChangeToken(raw) {
  if (!raw) return null;
  const hash = createHash('sha256').update(String(raw)).digest('hex');
  const row = db.prepare('SELECT tenant_id, new_email, expires_at, used FROM email_change_tokens WHERE token_hash=?').get(hash);
  if (!row || row.used || new Date(row.expires_at) < new Date()) return null;
  db.prepare('UPDATE email_change_tokens SET used=1 WHERE token_hash=?').run(hash);
  db.prepare('UPDATE tenants SET owner_email=? WHERE id=?').run(row.new_email, row.tenant_id);
  return { tenantId: row.tenant_id, newEmail: row.new_email };
}

/** Brand config for a tenant (DB row → falls back to env defaults for tenant 1). */
export function tenantBrand(id, envDefaults = {}) {
  const t = getTenant(id);
  if (!t) return envDefaults;
  return {
    name: t.brand_name || envDefaults.name,
    short: t.brand_short || envDefaults.short,
    theme: t.brand_theme || envDefaults.theme,
    logo: t.brand_logo || envDefaults.logo,
    unit: t.brand_unit || envDefaults.unit,
    package: t.package || envDefaults.package || 'line',
    slug: t.slug,
  };
}

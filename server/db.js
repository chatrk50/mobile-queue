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
import { hashPin, verifyPin } from './auth.js';

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
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}

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
  if (!have('loyalty:stamps_per_reward')) db.prepare(`INSERT INTO settings(key,value) VALUES('loyalty:stamps_per_reward','10')`).run();
  if (!have('loyalty:welcome_bonus')) db.prepare(`INSERT INTO settings(key,value) VALUES('loyalty:welcome_bonus','2')`).run();
  // SlipOK auto-verify + receipt printing: both prepared but OFF by default (owner enables later).
  if (!have('slip:auto')) db.prepare(`INSERT INTO settings(key,value) VALUES('slip:auto','0')`).run();
  if (!have('print:enabled')) db.prepare(`INSERT INTO settings(key,value) VALUES('print:enabled','0')`).run();
  // Starter raw materials (from the shop's Makro receipts) — only when the table is empty, so
  // it's a one-time editable seed. Stock left at 0 (owner counts/fills later); cost = price/unit.
  if (!db.prepare('SELECT COUNT(*) c FROM ingredients').get().c) {
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
  if (!db.prepare('SELECT COUNT(*) c FROM rewards').get().c) {
    db.prepare(`INSERT INTO rewards (name, cost_points, active, sort, image) VALUES ('เครื่องดื่มฟรี 1 แก้ว (ไม่เกิน 49฿)', 10, 1, 0, '/assets/menu/1-Original.png')`).run();
    console.log('[db] Seeded loyalty stamp card (disabled) + free-drink reward.');
  }
} catch (e) { console.error('[db] loyalty seed skipped:', e.message); }

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.QUEUE_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, 'queue.db');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const USE_TURSO = /^(libsql|https?):\/\//.test(TURSO_URL);

let raw;
let scheduleSync = () => {};   // debounced background push/pull (durable mode only)

if (USE_TURSO) {
  const { default: Database } = await import('libsql');
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

// WAL improves concurrency but isn't supported on some mounted/networked FS;
// fall back to the default rollback journal if it can't be enabled.
try { raw.exec('PRAGMA journal_mode = WAL'); } catch { /* default journal */ }
try { raw.exec('PRAGMA foreign_keys = ON'); } catch { /* ignore */ }

// libSQL's .get() attaches a non-column `_metadata` field — strip it so it never
// leaks into API responses (node:sqlite rows don't have it; the check is cheap).
const stripMeta = (row) => { if (row && typeof row === 'object' && '_metadata' in row) delete row._metadata; return row; };
const MUTATING = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const SCHEMA_OR_WRITE = /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

// Compatibility wrapper: prepare(...).run/get/all, exec, transaction()
export const db = {
  prepare(sql) {
    const st = raw.prepare(sql);
    const mutating = MUTATING.test(sql);
    return {
      run: (...a) => { const r = st.run(...a); if (mutating) scheduleSync(); return r; },
      get: (...a) => stripMeta(st.get(...a)),
      all: (...a) => st.all(...a).map(stripMeta),
    };
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
  date        TEXT PRIMARY KEY,           -- 'YYYY-MM-DD' (Asia/Bangkok)
  cups        INTEGER NOT NULL DEFAULT 0, -- drinks sold (excl. voided)
  revenue     REAL NOT NULL DEFAULT 0,
  gross       REAL NOT NULL DEFAULT 0,
  net         REAL NOT NULL DEFAULT 0,
  void_orders INTEGER NOT NULL DEFAULT 0,
  void_cups   INTEGER NOT NULL DEFAULT 0,
  void_amount REAL NOT NULL DEFAULT 0,
  issued      INTEGER NOT NULL DEFAULT 0,
  served      INTEGER NOT NULL DEFAULT 0,
  no_shows    INTEGER NOT NULL DEFAULT 0
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
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

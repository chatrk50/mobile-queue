// Storage layer on Node's BUILT-IN SQLite (node:sqlite, Node 22+).
// No native compilation, no extra dependency — runs anywhere Node 22+ runs.
// A tiny shim gives us the same prepare/run/get/all/transaction ergonomics.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.QUEUE_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const raw = new DatabaseSync(join(dataDir, 'queue.db'));
// WAL improves concurrency but isn't supported on some mounted/networked FS;
// fall back to the default rollback journal if it can't be enabled.
try { raw.exec('PRAGMA journal_mode = WAL'); } catch { /* default journal */ }
raw.exec('PRAGMA foreign_keys = ON');

// Compatibility wrapper: prepare(...).run/get/all, exec, transaction()
export const db = {
  prepare(sql) { return raw.prepare(sql); },
  exec(sql) { return raw.exec(sql); },
  // Mimics better-sqlite3 transaction(fn) -> function returning fn's result.
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    };
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

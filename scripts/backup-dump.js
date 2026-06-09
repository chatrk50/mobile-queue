// Read-only backup: connect to the durable Turso DB (embedded replica → sync → read), and
// print a full, restorable SQL dump (schema + data) to stdout. Run by the daily GitHub Action.
// Restore with:  turso db shell <db> < backup.sql   (or sqlite3 new.db < backup.sql)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const token = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!/^(libsql|https?):\/\//.test(url)) { console.error('TURSO_DATABASE_URL not set'); process.exit(1); }

const { default: Database } = await import('libsql');
const dir = mkdtempSync(join(tmpdir(), 'yodee-bk-'));
const db = new Database(join(dir, 'replica.db'), { syncUrl: url, authToken: token });
db.sync();   // pull the latest durable copy before reading

const esc = (v) => {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};

const ts = db.prepare("SELECT datetime('now') t").get().t;
let out = `-- YO-DEE backup @ ${ts} UTC\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n`;

// Schema first (tables before indexes), made idempotent so the dump is safe to re-apply.
const objs = db.prepare(
  "SELECT type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
).all();
for (const o of objs) {
  out += o.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ').replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ').replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ') + ';\n';
}

// Data rows. libsql attaches a non-column _metadata field on rows — strip it.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
let totalRows = 0;
for (const t of tables) {
  const rows = db.prepare(`SELECT * FROM "${t}"`).all();
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]).filter((c) => c !== '_metadata');
  const colList = cols.map((c) => `"${c}"`).join(',');
  for (const row of rows) out += `INSERT INTO "${t}" (${colList}) VALUES (${cols.map((c) => esc(row[c])).join(',')});\n`;
  totalRows += rows.length;
}
out += 'COMMIT;\n';

process.stdout.write(out);
process.stderr.write(`[backup] ${tables.length} tables, ${totalRows} rows, ${Buffer.byteLength(out)} bytes\n`);

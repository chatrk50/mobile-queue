// Reusable SQL dump of a SQLite/libSQL database (schema + data), restorable by replaying the
// statements into a fresh DB. Used by the daily backup (scripts/backup-dump.js) and the restore
// drill (scripts/test-restore.mjs) so the backup format is verified, not just assumed.
const esc = (v) => {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};

/** Return a full, restorable SQL dump string for `db` (a node:sqlite or libSQL handle). */
export function dumpSql(db, stamp = 'unknown') {
  let out = `-- backup @ ${stamp}\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n`;
  const objs = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  ).all();
  for (const o of objs) {
    out += o.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ') + ';\n';
  }
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
  return { sql: out, tables: tables.length, rows: totalRows };
}

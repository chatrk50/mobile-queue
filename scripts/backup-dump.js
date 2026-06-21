// Read-only backup: connect to the durable Turso DB (embedded replica → sync → read), and
// print a full, restorable SQL dump (schema + data) to stdout. Run by the daily GitHub Action.
// Restore with:  turso db shell <db> < backup.sql   (or sqlite3 new.db < backup.sql)
// The dump format is exercised by scripts/test-restore.mjs (restore drill), so it's verified.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpSql } from '../server/dump.js';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const token = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!/^(libsql|https?):\/\//.test(url)) { console.error('TURSO_DATABASE_URL not set'); process.exit(1); }

const { default: Database } = await import('libsql');
const dir = mkdtempSync(join(tmpdir(), 'yodee-bk-'));
const db = new Database(join(dir, 'replica.db'), { syncUrl: url, authToken: token });
db.sync();   // pull the latest durable copy before reading

const stamp = db.prepare("SELECT datetime('now') t").get().t + ' UTC';
const { sql, tables, rows } = dumpSql(db, stamp);
process.stdout.write(sql);
process.stderr.write(`[backup] ${tables} tables, ${rows} rows, ${Buffer.byteLength(sql)} bytes\n`);

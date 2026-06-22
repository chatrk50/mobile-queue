// Self-contained integration test for admin-console 2FA. Boots its OWN server with
// SAAS_ADMIN_TOTP_SECRET set (2FA on), exercises the login gate end-to-end, then tears it down.
// Complements scripts/test-totp.mjs (the algorithm) by covering the express gate + session.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { verifyTotp, base32Decode } from '../server/totp.js';
import { createHmac } from 'node:crypto';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';   // RFC sample seed (base32 of "12345678901234567890")
const PIN = 'adminsecret';
const PORT = 4736;
const BASE = `http://localhost:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Compute the current valid TOTP code (same algorithm the server uses).
function currentCode() {
  const sec = base32Decode(SECRET);
  let c = Math.floor(Date.now() / 1000 / 30);
  const b = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { b[i] = c & 0xff; c = Math.floor(c / 256); }
  const h = createHmac('sha1', sec).update(b).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const post = (body, headers = {}) => fetch(`${BASE}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const getTenants = (headers = {}) => fetch(`${BASE}/admin/api/tenants`, { headers });

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, SAAS: '1', SESSION_SECRET: 'sec-test-secret-1234567890', SAAS_ADMIN_PIN: PIN, SAAS_ADMIN_TOTP_SECRET: SECRET, PORT: String(PORT), QUEUE_DATA_DIR: mkdtempSync(join(tmpdir(), 'twofa-')) },
});

async function waitUp(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error('server did not start');
  console.log('2FA admin-console integration @ ' + BASE);

  // self-check the verifier agrees with the server's secret
  ok(verifyTotp(SECRET, currentCode()), 'test harness computes a valid current code');

  let r = await post({ adminPin: PIN });
  let d = await r.json();
  ok(d.ok === false && d.totpRequired === true, 'PIN alone → ok:false, totpRequired:true');

  ok((await getTenants({ 'x-admin-pin': PIN })).status === 401, 'admin API with PIN only (2FA on) → 401');

  r = await post({ adminPin: PIN, totp: '000000' });
  d = await r.json();
  ok(d.ok === false && d.error === 'bad_totp', 'PIN + wrong code → ok:false bad_totp');

  r = await post({ adminPin: 'wrong', totp: currentCode() });
  d = await r.json();
  ok(d.ok === false, 'wrong PIN + right code → ok:false');

  r = await post({ adminPin: PIN, totp: currentCode() });
  d = await r.json();
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok(d.ok === true && /^asess=/.test(cookie), 'PIN + valid code → ok:true + asess session cookie');
  ok(/HttpOnly/i.test(r.headers.get('set-cookie') || ''), 'admin session cookie is HttpOnly');

  ok((await getTenants({ Cookie: cookie })).status === 200, 'admin API with the session cookie → 200');
  ok((await getTenants({})).status === 401, 'admin API with neither PIN nor session → 401');

  console.log(`\n${fail ? '❌ 2FA FAILED' : '✅ 2FA'} — ${pass} passed, ${fail} failed`);
} catch (e) {
  console.error('2fa test crashed:', e.message); fail++;
} finally {
  child.kill();
}
process.exit(fail ? 1 : 0);

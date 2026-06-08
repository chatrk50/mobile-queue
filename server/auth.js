// Staff authentication helpers (Phase 0 = PIN hashing + session cookie crypto;
// the role/branch middleware that USES these lands in Phase 1).
//
// PINs are short, so we hash them with scrypt + a per-PIN random salt. That's
// not a substitute for a strong password, but combined with the IP lockout in
// index.js it's the right strength for an in-shop counter device.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const SCRYPT_N = 16384, KEYLEN = 32;

/** Hash a PIN -> "scrypt$<saltHex>$<hashHex>" (self-describing, safe to store). */
export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verify of a PIN against a stored "scrypt$salt$hash" string. */
export function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = scryptSync(String(pin), salt, expected.length, { N: SCRYPT_N });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

// ---- Session cookie (HMAC-signed, stateless) — wired into middleware in Phase 1 ----
const SESSION_SECRET = process.env.SESSION_SECRET
  || process.env.CASHIER_PIN  // dev fallback so local works without extra config
  || 'dev-insecure-session-secret-change-me';

/** Sign a small JSON payload into "<b64url(json)>.<b64url(hmac)>". */
export function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify + decode a session token; returns the payload or null. */
export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '', 'utf8'), b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

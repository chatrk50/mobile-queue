// RFC 6238 TOTP (time-based one-time password) — second factor for the platform-admin console.
// Zero dependencies (HMAC-SHA1 via node:crypto), like the manual JWT verify in google.js.
// The admin enrols a base32 secret in any authenticator (Google Authenticator, Authy, 1Password)
// and sets it as SAAS_ADMIN_TOTP_SECRET; when present, admin login requires a fresh 6-digit code.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
/** RFC 4648 base32 decode (tolerant: ignores spaces, padding, case). */
export function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;                 // skip spaces / separators
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Verify a 6-digit TOTP against a base32 secret. ±`window` steps tolerate clock skew.
 *  Returns false for any malformed input — never throws. */
export function verifyTotp(secret, token, { step = 30, window = 1, t = Date.now() } = {}) {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  let secretBuf; try { secretBuf = base32Decode(secret); } catch { return false; }
  if (!secretBuf.length) return false;
  const ctr = Math.floor((t / 1000) / step);
  for (let w = -window; w <= window; w++) {
    if (safeEqual(hotp(secretBuf, ctr + w), code)) return true;
  }
  return false;
}

/** Generate a fresh base32 secret (160-bit) for enrolment. */
export function generateTotpSecret() { return base32Encode(randomBytes(20)); }

/** Build the otpauth:// URL an authenticator app scans (or paste the secret manually). */
export function otpauthUrl(secret, { issuer = 'YO-DEE SaaS Admin', account = 'admin' } = {}) {
  const label = encodeURIComponent(issuer + ':' + account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

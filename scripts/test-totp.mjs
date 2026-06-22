// Pure unit test for server/totp.js — RFC 6238 test vectors + base32 roundtrip + window/skew.
// No server needed (the admin-login integration is covered by the live dryrun check).
import { base32Encode, base32Decode, verifyTotp, generateTotpSecret, otpauthUrl } from '../server/totp.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };

// base32 roundtrip
const raw = Buffer.from('Hello!\xDE\xAD\xBE\xEF', 'binary');
ok(Buffer.compare(base32Decode(base32Encode(raw)), raw) === 0, 'base32 encode/decode roundtrip');
ok(base32Encode(Buffer.from('12345678901234567890')) === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 of the RFC ASCII seed matches');

// RFC 6238 Appendix B vectors (SHA1, 6-digit). Secret = ASCII "12345678901234567890".
const secret = base32Encode(Buffer.from('12345678901234567890'));
ok(verifyTotp(secret, '287082', { t: 59 * 1000, window: 0 }), 'RFC vector T=59 → 287082');
ok(verifyTotp(secret, '081804', { t: 1111111109 * 1000, window: 0 }), 'RFC vector T=1111111109 → 081804');
ok(verifyTotp(secret, '005924', { t: 1234567890 * 1000, window: 0 }), 'RFC vector T=1234567890 → 005924');

// Negatives
ok(!verifyTotp(secret, '000000', { t: 59 * 1000, window: 0 }), 'wrong code rejected');
ok(!verifyTotp(secret, '287082', { t: (59 + 120) * 1000, window: 1 }), 'a code 4 steps away rejected (outside ±1 window)');
ok(!verifyTotp(secret, '28708', { t: 59 * 1000 }), '5-digit code rejected');
ok(!verifyTotp(secret, 'abcdef', { t: 59 * 1000 }), 'non-numeric rejected');
ok(!verifyTotp('', '287082', { t: 59 * 1000 }), 'empty secret rejected');

// Window tolerance: the previous step's code still verifies within ±1.
ok(verifyTotp(secret, '287082', { t: (59 + 30) * 1000, window: 1 }), 'previous-step code accepted within ±1 (clock skew)');

// Generator + otpauth
const gen = generateTotpSecret();
ok(/^[A-Z2-7]{32}$/.test(gen), 'generateTotpSecret → 32-char base32');
ok(otpauthUrl(gen, { account: 'a' }).startsWith('otpauth://totp/') && otpauthUrl(gen).includes('secret='), 'otpauthUrl well-formed');

console.log(`\n${fail ? '❌ TOTP FAILED' : '✅ TOTP'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

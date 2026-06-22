// One-shot helper to enrol 2FA for the platform-admin console.
// Generates a fresh TOTP secret + the otpauth:// URL to add to an authenticator app
// (Google Authenticator / Authy / 1Password), then prints the env line to set on the host.
//
//   node scripts/admin-2fa-setup.mjs
//
// Add the printed SAAS_ADMIN_TOTP_SECRET to your SaaS service env (Render dashboard) and redeploy.
// From then on, the admin console login requires the rotating 6-digit code in addition to the PIN.
// To verify a code before committing, pass it as an argument: node scripts/admin-2fa-setup.mjs 123456
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../server/totp.js';

const arg = process.argv[2];
// If a secret is already in the env, verify a supplied code against it; otherwise mint a new one.
const existing = (process.env.SAAS_ADMIN_TOTP_SECRET || '').trim();

if (existing && arg) {
  console.log(verifyTotp(existing, arg) ? '✅ code is valid for the current SAAS_ADMIN_TOTP_SECRET' : '❌ code does NOT match — check the time/secret');
  process.exit(0);
}

const secret = existing || generateTotpSecret();
const url = otpauthUrl(secret);
console.log('\n=== Platform-admin 2FA enrolment ===\n');
console.log('1) Add this account to your authenticator app (scan the otpauth URL as a QR, or paste the secret manually):\n');
console.log('   secret (base32): ' + secret);
console.log('   otpauth URL    : ' + url + '\n');
console.log('2) Set this on your SaaS host (Render → Environment) and redeploy:\n');
console.log('   SAAS_ADMIN_TOTP_SECRET=' + secret + '\n');
console.log('3) Verify it works before relying on it:  node scripts/admin-2fa-setup.mjs <6-digit-code>');
console.log('   (with SAAS_ADMIN_TOTP_SECRET set in your shell)\n');
console.log('Keep the secret private — anyone with it can generate your 2FA codes.\n');

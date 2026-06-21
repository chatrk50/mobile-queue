// Verify a Google "Sign in with Google" ID token (JWT, RS256) server-side, with no extra deps.
// Gated by GOOGLE_CLIENT_ID; returns the verified email or throws. Card/login data is Google's.
import { createPublicKey, createVerify } from 'node:crypto';

export const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
export const GOOGLE_ON = Boolean(GOOGLE_CLIENT_ID);

let jwksCache = { at: 0, keys: {} };
async function googleKeys() {
  if (Date.now() - jwksCache.at < 3600_000 && Object.keys(jwksCache.keys).length) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await res.json();
  const keys = {};
  for (const k of (data.keys || [])) keys[k.kid] = k;
  jwksCache = { at: Date.now(), keys };
  return keys;
}
const b64urlJson = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

/** Verify a Google ID token and return { email } if valid (sig + aud + iss + exp + email_verified). */
export async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_ON) throw new Error('google_off');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('bad_token');
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  const keys = await googleKeys();
  const jwk = keys[header.kid];
  if (!jwk) throw new Error('unknown_key');
  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  const v = createVerify('RSA-SHA256');
  v.update(parts[0] + '.' + parts[1]);
  v.end();
  const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!v.verify(pub, sig)) throw new Error('bad_signature');
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('bad_audience');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('bad_issuer');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('expired');
  if (!payload.email || payload.email_verified === false) throw new Error('email_unverified');
  return { email: String(payload.email).toLowerCase() };
}

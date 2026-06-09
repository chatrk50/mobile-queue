// Thai QR Payment (EMVCo) helpers: take the shop's STATIC merchant QR (the K SHOP /
// PromptPay image) and produce a DYNAMIC version with the bill amount pre-filled —
// exactly what a POS does. We don't need a merchant API: the static QR already contains
// the merchant account; we just flip the "point of initiation" to dynamic (tag 01 = 12),
// insert the amount (tag 54), and recompute the CRC (tag 63).

import { readFileSync, existsSync } from 'node:fs';

/**
 * Decode the shop's static QR image (PNG or JPEG) into its EMVCo payload string, once at
 * boot. Returns the merchant template (CRC-verified) or null if the file is missing/not a QR.
 * jpeg-js / pngjs / jsqr are loaded lazily so a missing image never crashes startup.
 */
export async function decodeMerchantTemplate(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    const buf = readFileSync(filePath);
    let px;
    if (buf[0] === 0xFF && buf[1] === 0xD8) {            // JPEG
      const { default: jpeg } = await import('jpeg-js');
      const r = jpeg.decode(buf, { useTArray: true });
      px = { data: r.data, width: r.width, height: r.height };
    } else {                                             // PNG
      const { PNG } = await import('pngjs');
      const r = PNG.sync.read(buf);
      px = { data: r.data, width: r.width, height: r.height };
    }
    const { default: jsQR } = await import('jsqr');
    const code = jsQR(new Uint8ClampedArray(px.data), px.width, px.height);
    if (!code || !code.data || !verifyCRC(code.data)) return null;
    return code.data;
  } catch { return null; }
}

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the ASCII payload incl. "6304".
export function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Parse top-level EMVCo TLV (tag=2 digits, len=2 digits, value=len chars). Values of
// nested templates are kept opaque — we only touch top-level tags 01/54/63.
export function parseTLV(s) {
  const out = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.substr(i, 2);
    const len = parseInt(s.substr(i + 2, 2), 10);
    if (!Number.isFinite(len)) break;
    out.push({ tag, val: s.substr(i + 4, len) });
    i += 4 + len;
  }
  return out;
}
const tlv = (tag, val) => tag + String(val.length).padStart(2, '0') + val;

/** Recompute and verify a payload's CRC (sanity check on a decoded static QR). */
export function verifyCRC(payload) {
  const i = payload.lastIndexOf('6304');
  if (i < 0) return false;
  const body = payload.slice(0, i + 4);
  return crc16(body) === payload.slice(i + 4, i + 8).toUpperCase();
}

/**
 * Build a dynamic-amount payload from the shop's static merchant template.
 * Preserves the merchant account fields; sets dynamic + amount; appends a fresh CRC.
 */
export function buildDynamicPayload(template, amount) {
  const fields = parseTLV(template).filter((f) => f.tag !== '63' && f.tag !== '54');
  for (const f of fields) if (f.tag === '01') f.val = '12';   // 11 static -> 12 dynamic
  const amt = { tag: '54', val: (Number(amount) || 0).toFixed(2) };
  let idx = fields.findIndex((f) => f.tag === '58');           // amount sits before country code
  if (idx < 0) idx = fields.findIndex((f) => f.tag === '59');
  if (idx < 0) idx = fields.length;
  fields.splice(idx, 0, amt);
  const body = fields.map((f) => tlv(f.tag, f.val)).join('') + '6304';
  return body + crc16(body);
}

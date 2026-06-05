// Generate static "offline" QR PNGs — one per zone. Print these and stick them at
// the storefront. Scanning opens the customer page for that exact zone.
//
// If LIFF_ID is set in .env, QRs point at the LINE LIFF URL (opens inside LINE,
// so the customer is identified automatically). Otherwise they point at the local
// customer page for testing.
import 'dotenv/config';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { db } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'assets', 'qr');
mkdirSync(outDir, { recursive: true });

const LIFF_ID = process.env.LIFF_ID || '';
const BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const zones = db.prepare('SELECT z.*, s.name AS store_name FROM zones z JOIN stores s ON s.id=z.store_id').all();
if (!zones.length) { console.log('No zones. Run `npm run seed` first.'); process.exit(0); }

for (const z of zones) {
  const target = LIFF_ID
    ? `https://liff.line.me/${LIFF_ID}?zone=${z.id}`
    : `${BASE}/liff/?zone=${z.id}`;
  const file = join(outDir, `zone-${z.id}.png`);
  await QRCode.toFile(file, target, { width: 600, margin: 2 });
  console.log(`QR for ${z.store_name} / ${z.name} -> ${target}\n  saved ${file}`);
}
console.log(`\nDone. ${LIFF_ID ? 'LIFF' : 'LOCAL'} QR codes in public/assets/qr/`);

// SlipOK (https://slipok.com) — verifies a Thai bank-transfer slip against the bank: the transfer
// really happened, for this amount, into the account linked to the SlipOK branch, and the same slip
// has not been submitted before. One SlipOK "branch" = one receiving account, so the credentials
// belong to a shop branch, not to the app (see getPayConfig in queue.js).
//
//   POST https://api.slipok.com/api/line/apikey/<branchId>      header x-authorization: <apiKey>
//        multipart: files=<image> | data=<qr text> | url=<image url>; amount=<expected>; log=true
//   GET  https://api.slipok.com/api/line/apikey/<branchId>/quota → { success, data: { quota, overQuota } }
//
// log=true is what makes SlipOK check the receiving account and reject a duplicate slip — and what
// consumes quota. Without it the call is a free OCR that proves nothing, so it is always on here.

// SLIPOK_API_BASE lets UAT / a local run point at a stand-in SlipOK (same routes, canned answers) so the
// whole customer flow can be walked without a real slip or a real key. Unset in prod.
export const SLIPOK_BASE = (process.env.SLIPOK_API_BASE || '').trim() || 'https://api.slipok.com/api/line/apikey';

/** Error codes from https://slipok.com/api-documentation/error-status-code/ — Thai for the customer. */
export const SLIPOK_ERRORS = {
  1000: 'ไม่พบข้อมูล QR ในคำขอ',
  1001: 'ตั้งค่า SlipOK ไม่ถูกต้อง (ไม่พบ Branch ID) — แจ้งร้าน',
  1002: 'ตั้งค่า SlipOK ไม่ถูกต้อง (API key) — แจ้งร้าน',
  1003: 'แพ็กเกจ SlipOK ของร้านหมดอายุ — แจ้งร้าน',
  1004: 'โควตาตรวจสลิปของร้านหมด — แจ้งร้าน',
  1005: 'ไฟล์ไม่ใช่รูปภาพ (รับ .jpg .png .webp)',
  1006: 'รูปภาพเสียหาย ลองถ่ายใหม่',
  1007: 'ในรูปไม่มี QR ของสลิป — ถ่ายให้เห็น QR มุมขวาล่างชัด ๆ',
  1008: 'QR นี้ไม่ใช่ QR ของสลิปโอนเงิน',
  1009: 'ระบบธนาคารขัดข้องชั่วคราว ลองใหม่ใน 15 นาที',
  1010: 'สลิปธนาคารนี้ต้องรอสักครู่ก่อนตรวจได้ ลองใหม่อีกครั้ง',
  1011: 'QR หมดอายุ หรือไม่พบรายการโอนนี้',
  1012: 'สลิปนี้ถูกใช้ไปแล้ว',
  1013: 'ยอดเงินไม่ตรงกับออเดอร์',
  1014: 'บัญชีผู้รับไม่ใช่บัญชีของร้าน',
  1015: 'ไม่พบแพ็กเกจ SlipOK ของร้าน — แจ้งร้าน',
};

const norm = (j) => {
  const data = j && j.data && typeof j.data === 'object' ? j.data : null;
  const code = j?.code ?? data?.code ?? null;
  return { data, code: code == null ? null : Number(code), rawMessage: j?.message || data?.message || '' };
};

/** Verify one slip image. Never throws on a SlipOK refusal — returns { ok:false, code, message };
 *  throws only when SlipOK itself cannot be reached. `fetchImpl` lets tests stand in for the network. */
export async function slipokCheck({ branchId, apiKey, imageBase64, mime = 'image/jpeg', amount = null, fetchImpl = fetch, log = true } = {}) {
  if (!branchId || !apiKey) return { ok: false, code: 1002, message: SLIPOK_ERRORS[1002] };
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from(imageBase64, 'base64')], { type: mime }), 'slip.jpg');
  // log=false is the owner's diagnostic: SlipOK reads the slip and answers, without recording it
  // as used - so the customer's own submission of the same slip is not refused as a duplicate later.
  fd.append('log', log ? 'true' : 'false');
  if (amount != null && Number(amount) > 0) fd.append('amount', String(Number(amount)));
  const r = await fetchImpl(`${SLIPOK_BASE}/${encodeURIComponent(branchId)}`, { method: 'POST', headers: { 'x-authorization': apiKey }, body: fd });
  const j = await r.json().catch(() => ({}));
  const { data, code, rawMessage } = norm(j);
  if (r.ok && j.success && data && data.success) return { ok: true, code: null, message: '', data };
  // 1010 = BBL / SCB have not released the transfer yet; SlipOK says how long (minutes) to wait.
  const wait = code === 1010 && data && Number(data.delay) > 0 ? ' (ประมาณ ' + Number(data.delay) + ' นาที)' : '';
  return { ok: false, code, message: ((code != null && SLIPOK_ERRORS[code]) || rawMessage || 'ตรวจสลิปไม่สำเร็จ') + wait, data };
}

/** Remaining quota — the cheapest way to prove a branch's key + id are right (no slip needed). */
export async function slipokQuota({ branchId, apiKey, fetchImpl = fetch } = {}) {
  if (!branchId || !apiKey) return { ok: false, code: 1002, message: SLIPOK_ERRORS[1002] };
  const r = await fetchImpl(`${SLIPOK_BASE}/${encodeURIComponent(branchId)}/quota`, { headers: { 'x-authorization': apiKey } });
  const j = await r.json().catch(() => ({}));
  const { data, code, rawMessage } = norm(j);
  if (r.ok && j.success && data) return { ok: true, quota: Number(data.quota) || 0, overQuota: Number(data.overQuota) || 0 };
  return { ok: false, code, message: (code != null && SLIPOK_ERRORS[code]) || rawMessage || 'เชื่อมต่อ SlipOK ไม่สำเร็จ' };
}

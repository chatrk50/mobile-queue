// Tiny in-memory pub/sub for Server-Sent Events. Cashier & display screens
// subscribe per-zone and get live pushes on any queue change.
// Each subscriber carries a `reveal` flag (PIN-verified cashier) so we can send
// real customer names only to staff and masked names to public/display screens.
const clients = new Map(); // zoneId -> Set({ res, reveal })

export function subscribe(zoneId, res, { reveal = false } = {}) {
  zoneId = String(zoneId);
  if (!clients.has(zoneId)) clients.set(zoneId, new Set());
  const sub = { res, reveal };
  clients.get(zoneId).add(sub);
  res.on('close', () => clients.get(zoneId)?.delete(sub));
}

/**
 * Emit an event to all subscribers of a zone.
 * `data` may be a plain value (sent to everyone) or a function `(reveal) => value`
 * so privileged (cashier) and public (display) subscribers get different payloads.
 */
export function emit(zoneId, event, data) {
  const set = clients.get(String(zoneId));
  if (!set) return;
  const isFn = typeof data === 'function';
  let cachedPublic, cachedReveal, hasPub = false, hasRev = false;
  for (const { res, reveal } of set) {
    let payloadData;
    if (!isFn) payloadData = data;
    else if (reveal) { if (!hasRev) { cachedReveal = data(true); hasRev = true; } payloadData = cachedReveal; }
    else { if (!hasPub) { cachedPublic = data(false); hasPub = true; } payloadData = cachedPublic; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(payloadData)}\n\n`);
  }
}

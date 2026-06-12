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
// Heartbeat: proxies / load balancers (and Render's free tier) silently close idle SSE
// sockets, after which the cashier stops getting live pushes until a manual refresh. A
// periodic comment keeps the connection alive and lets the browser detect a dead one and
// auto-reconnect. Dead writes are pruned.
setInterval(() => {
  for (const [zoneId, set] of clients) {
    for (const sub of set) {
      try { sub.res.write(': hb\n\n'); } catch { set.delete(sub); }
    }
    if (!set.size) clients.delete(zoneId);
  }
}, 20000);

export function emit(zoneId, event, data) {
  const set = clients.get(String(zoneId));
  if (!set || !set.size) return;
  // Defer the broadcast to the next tick: `data` is usually a snapshot builder whose queries
  // would otherwise run synchronously and delay the HTTP response that triggered this emit
  // (e.g. the cashier's "take order" / "pay" call). The committed writes are already in the DB,
  // so the deferred snapshot still reflects them — subscribers just get it a tick later.
  setImmediate(() => {
    const live = clients.get(String(zoneId));
    if (!live || !live.size) return;
    const isFn = typeof data === 'function';
    let cachedPublic, cachedReveal, hasPub = false, hasRev = false;
    for (const { res, reveal } of live) {
      let payloadData;
      if (!isFn) payloadData = data;
      else if (reveal) { if (!hasRev) { cachedReveal = data(true); hasRev = true; } payloadData = cachedReveal; }
      else { if (!hasPub) { cachedPublic = data(false); hasPub = true; } payloadData = cachedPublic; }
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(payloadData)}\n\n`); } catch { /* dropped client */ }
    }
  });
}

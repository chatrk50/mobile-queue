// Tiny in-memory pub/sub for Server-Sent Events. Cashier & display screens
// subscribe per-zone and get live pushes on any queue change.
const clients = new Map(); // zoneId -> Set(res)

export function subscribe(zoneId, res) {
  zoneId = String(zoneId);
  if (!clients.has(zoneId)) clients.set(zoneId, new Set());
  clients.get(zoneId).add(res);
  res.on('close', () => clients.get(zoneId)?.delete(res));
}

export function emit(zoneId, event, data) {
  const set = clients.get(String(zoneId));
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

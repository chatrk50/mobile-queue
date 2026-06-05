import { db } from './db.js';
import { pushQueue } from './line.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;

// LIFF link so the customer can re-open their queue anytime (sent as a button
// on the LINE card, so the raw URL stays hidden behind a label).
const LIFF_ID = process.env.LIFF_ID || '';
const queueLink = (zoneId) =>
  LIFF_ID ? `https://liff.line.me/${LIFF_ID}?zone=${zoneId}` : null;

export function getZone(zoneId) {
  return db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
}

/** A customer's still-active ticket in a zone, so re-opening the LIFF resumes it
 *  even if the browser/app was closed (looked up by their LINE user id). */
export function findActiveTicket(zoneId, lineUserId) {
  if (!lineUserId) return null;
  return db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND line_user_id = ? AND status IN ('waiting','called')
     ORDER BY id DESC LIMIT 1`
  ).get(zoneId, lineUserId);
}

/** How many waiting groups are ahead of this ticket in its zone. */
export function aheadCount(ticket) {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM tickets
     WHERE zone_id = ? AND status = 'waiting' AND number < ?`
  ).get(ticket.zone_id, ticket.number);
  return row.c;
}

/** Issue a new ticket in a zone. Returns the created ticket row (or throws). */
export function issueTicket({ storeId, zoneId, partySize = 1, lineUserId = null, customerName = null }) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error('zone_not_found');
  if (!zone.is_open) throw new Error('zone_closed');

  // No duplicate numbers per customer: if they already hold an active ticket in
  // this zone, return it instead of issuing a new one (and skip the extra push).
  if (lineUserId) {
    const existing = findActiveTicket(zoneId, lineUserId);
    if (existing) return { ticket: existing, ahead: aheadCount(existing) };
  }

  const tx = db.transaction(() => {
    // Re-read the counter inside the transaction so numbers are never reused.
    const cur = db.prepare('SELECT last_number, prefix FROM zones WHERE id = ?').get(zoneId);
    const next = cur.last_number + 1;
    db.prepare('UPDATE zones SET last_number = ? WHERE id = ?').run(next, zoneId);
    const info = db.prepare(
      `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(storeId, zoneId, next, code(cur.prefix, next), partySize, lineUserId, customerName);
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
  });

  const ticket = tx();
  const ahead = aheadCount(ticket);

  // Confirmation push (fire and forget)
  pushQueue(lineUserId,
    `🎫 Queue confirmed\n` +
    `Your number: ${ticket.code}\n` +
    `Groups ahead: ${ahead}\n` +
    `We'll notify you here on LINE when you're up soon.`,
    queueLink(zoneId));

  return { ticket, ahead };
}

/**
 * Call the next waiting ticket in a zone (lowest number).
 * After calling, evaluate "coming up soon" notifications for the new front of line.
 */
export function callNext(zoneId, threshold) {
  const zone = getZone(zoneId);
  if (!zone) throw new Error('zone_not_found');

  const next = db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND status = 'waiting'
     ORDER BY number ASC LIMIT 1`
  ).get(zoneId);
  if (!next) return { called: null };

  db.prepare(
    `UPDATE tickets SET status='called', called_at=datetime('now'), called_count=called_count+1 WHERE id=?`
  ).run(next.id);
  db.prepare('UPDATE zones SET last_called = ? WHERE id = ?').run(next.number, zoneId);

  pushQueue(next.line_user_id,
    `🔔 It's your turn!\n` +
    `Number: ${next.code}\n` +
    `Please come to the counter.`,
    queueLink(zoneId));

  evaluateSoonNotifications(zoneId, threshold);
  return { called: next };
}

/** Mark a called ticket served, or skip / cancel any ticket. */
export function setStatus(ticketId, status, threshold) {
  const allowed = ['served', 'skipped', 'cancelled', 'no_show'];
  if (!allowed.includes(status)) throw new Error('bad_status');
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  db.prepare(`UPDATE tickets SET status=?, closed_at=datetime('now') WHERE id=?`).run(status, ticketId);
  if (threshold != null) evaluateSoonNotifications(t.zone_id, threshold);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
}

/**
 * Send a one-time "coming up soon" push to any waiting ticket that is now within
 * `threshold` groups of the front and hasn't been notified yet.
 */
export function evaluateSoonNotifications(zoneId, threshold) {
  const waiting = db.prepare(
    `SELECT * FROM tickets WHERE zone_id = ? AND status='waiting'
     ORDER BY number ASC`
  ).all(zoneId);

  waiting.forEach((t, idx) => {
    const ahead = idx; // position in the ordered waiting list
    if (ahead <= threshold && !t.notified_soon && t.line_user_id) {
      db.prepare('UPDATE tickets SET notified_soon = 1 WHERE id = ?').run(t.id);
      pushQueue(t.line_user_id,
        `⏰ You're up soon!\n` +
        `Number: ${t.code}\n` +
        `Groups ahead: ${ahead}\n` +
        `Please head back to the store.`,
        queueLink(zoneId));
    }
  });
}

/** Customer rating (1..5) for a served ticket. */
export function setRating(ticketId, stars) {
  const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
  const t = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId);
  if (!t) throw new Error('ticket_not_found');
  db.prepare('UPDATE tickets SET rating = ? WHERE id = ?').run(s, ticketId);
  return { ok: true, rating: s };
}

/** Daily report: cups sold, no-shows, avg wait, avg rating + per-zone, since the last reset. */
export function dailyReport() {
  const perZone = db.prepare(
    `SELECT z.id, z.name, z.prefix, z.last_number AS issued,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served')  AS served,
       (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show') AS no_shows
     FROM zones z ORDER BY z.id`
  ).all();
  const cupsSold = perZone.reduce((s, z) => s + z.served, 0);
  const issued = perZone.reduce((s, z) => s + z.issued, 0);
  const noShows = perZone.reduce((s, z) => s + z.no_shows, 0);
  const wait = db.prepare(
    `SELECT AVG((julianday(called_at)-julianday(created_at))*86400) AS s
     FROM tickets WHERE called_at IS NOT NULL`
  ).get();
  const rating = db.prepare(
    `SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM tickets WHERE rating IS NOT NULL`
  ).get();
  return {
    cupsSold, issued, noShows,
    avgWaitMin: wait.s != null ? Math.round((wait.s / 60) * 10) / 10 : null,
    avgRating: rating.avg != null ? Math.round(rating.avg * 10) / 10 : null,
    ratingCount: rating.n,
    perZone,
  };
}

/** Daily reset: clear all tickets and restart numbering from 0 in every zone. */
export function resetAllZones() {
  const tx = db.transaction(() => {
    // Archive a per-zone daily summary (history) before clearing the tickets.
    db.prepare(
      `INSERT OR REPLACE INTO daily_stats (date, zone_id, issued, served, no_shows, avg_wait_sec, avg_rating)
       SELECT date('now','+7 hours'), z.id, z.last_number,
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='served'),
         (SELECT COUNT(*) FROM tickets t WHERE t.zone_id=z.id AND t.status='no_show'),
         (SELECT CAST(AVG((julianday(called_at)-julianday(created_at))*86400) AS INTEGER) FROM tickets t WHERE t.zone_id=z.id AND t.called_at IS NOT NULL),
         (SELECT AVG(rating) FROM tickets t WHERE t.zone_id=z.id AND t.rating IS NOT NULL)
       FROM zones z`
    ).run();
    db.exec(`DELETE FROM tickets`);
    db.exec(`UPDATE zones SET last_number = 0, last_called = 0`);
  });
  tx();
  return db.prepare('SELECT id FROM zones').all().map((z) => z.id);
}

export function setZoneOpen(zoneId, isOpen) {
  db.prepare('UPDATE zones SET is_open = ? WHERE id = ?').run(isOpen ? 1 : 0, zoneId);
  return getZone(zoneId);
}

/** Snapshot of a zone for cashier/display: waiting list + recently called. */
export function zoneSnapshot(zoneId) {
  const zone = getZone(zoneId);
  if (!zone) return null;
  const waiting = db.prepare(
    `SELECT id, code, number, party_size, customer_name, notified_soon FROM tickets
     WHERE zone_id=? AND status='waiting' ORDER BY number ASC`
  ).all(zoneId);
  const recentCalled = db.prepare(
    `SELECT id, code, number, party_size, customer_name, called_at FROM tickets
     WHERE zone_id=? AND status='called' ORDER BY called_at DESC LIMIT 5`
  ).all(zoneId);
  return { zone, waiting, recentCalled, waitingCount: waiting.length };
}

export function ticketView(ticketId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!t) return null;
  const zone = getZone(t.zone_id);
  return {
    id: t.id, code: t.code, status: t.status, party_size: t.party_size, rating: t.rating,
    zone: zone.name, ahead: t.status === 'waiting' ? aheadCount(t) : 0,
    last_called: zone.last_called ? `${zone.prefix}${pad(zone.last_called)}` : null,
  };
}

import { db } from './db.js';
import { pushText } from './line.js';

const pad = (n) => String(n).padStart(3, '0');
const code = (prefix, n) => `${prefix}${pad(n)}`;

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

  const tx = db.transaction(() => {
    const next = zone.last_number + 1;
    db.prepare('UPDATE zones SET last_number = ? WHERE id = ?').run(next, zoneId);
    const info = db.prepare(
      `INSERT INTO tickets (store_id, zone_id, number, code, party_size, line_user_id, customer_name)
       VALUES (?,?,?,?,?,?,?)`
    ).run(storeId, zoneId, next, code(zone.prefix, next), partySize, lineUserId, customerName);
    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
  });

  const ticket = tx();
  const ahead = aheadCount(ticket);

  // Confirmation push (fire and forget)
  pushText(lineUserId,
    `🎫 รับคิวสำเร็จ / Queue confirmed\n` +
    `หมายเลขของคุณ / Your number: ${ticket.code}\n` +
    `รออีก / Groups ahead: ${ahead}\n` +
    `เราจะแจ้งเตือนเมื่อใกล้ถึงคิวของคุณ / We'll notify you when you're up soon.`);

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
    `UPDATE tickets SET status='called', called_at=datetime('now') WHERE id=?`
  ).run(next.id);
  db.prepare('UPDATE zones SET last_called = ? WHERE id = ?').run(next.number, zoneId);

  pushText(next.line_user_id,
    `🔔 ถึงคิวของคุณแล้ว! / It's your turn!\n` +
    `หมายเลข / Number: ${next.code}\n` +
    `เชิญที่เคาน์เตอร์ / Please come to the counter.`);

  evaluateSoonNotifications(zoneId, threshold);
  return { called: next };
}

/** Mark a called ticket served, or skip / cancel any ticket. */
export function setStatus(ticketId, status, threshold) {
  const allowed = ['served', 'skipped', 'cancelled'];
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
      pushText(t.line_user_id,
        `⏰ ใกล้ถึงคิวของคุณแล้ว / You're up soon!\n` +
        `หมายเลข / Number: ${t.code}\n` +
        `เหลืออีก / Groups ahead: ${ahead}\n` +
        `กรุณากลับมาที่ร้าน / Please head back to the store.`);
    }
  });
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
    id: t.id, code: t.code, status: t.status, party_size: t.party_size,
    zone: zone.name, ahead: t.status === 'waiting' ? aheadCount(t) : 0,
    last_called: zone.last_called ? `${zone.prefix}${pad(zone.last_called)}` : null,
  };
}

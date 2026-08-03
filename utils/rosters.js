const db = require('../db');

// All active rosters an active member belongs to that include the given
// calendar date as one of their session dates.
function getMemberRostersForDate(memberId, dateISO) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       JOIN roster_dates rd ON rd.roster_id = r.id AND rd.session_date = ?
       WHERE rm.member_id = ? AND r.active = 1
       ORDER BY r.name COLLATE NOCASE`
    )
    .all(dateISO, memberId);
}

// All distinct upcoming (>= fromISO) session dates across every active
// roster the member belongs to, ascending, deduplicated.
function getMemberUpcomingDates(memberId, fromISO) {
  return db
    .prepare(
      `SELECT DISTINCT rd.session_date AS date FROM roster_dates rd
       JOIN rosters r ON r.id = rd.roster_id AND r.active = 1
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? AND rd.session_date >= ?
       ORDER BY rd.session_date ASC`
    )
    .all(memberId, fromISO)
    .map((row) => row.date);
}

module.exports = { getMemberRostersForDate, getMemberUpcomingDates };

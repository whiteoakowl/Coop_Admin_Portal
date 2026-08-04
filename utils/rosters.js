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

module.exports = { getMemberRostersForDate };

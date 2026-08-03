const db = require('../db');

// All active rosters an active member belongs to that meet on the given day.
function getMemberRostersForDay(memberId, day) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       WHERE rm.member_id = ? AND r.day = ? AND r.active = 1
       ORDER BY r.name COLLATE NOCASE`
    )
    .all(memberId, day);
}

module.exports = { getMemberRostersForDay };

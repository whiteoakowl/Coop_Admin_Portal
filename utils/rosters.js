const db = require('../db');

// Display labels for attendance.reason_category, shared by the admin
// Absence/Late log (admin-members.js, admin-rosters.js) and anywhere else
// that renders a submitted absence/late reason.
const REASON_LABELS = { personal: 'Personal', medical: 'Medical' };

// All active rosters an active member belongs to that include the given
// calendar date as one of their session dates.
async function getMemberRostersForDate(memberId, dateISO) {
  return db
    .prepare(
      `SELECT r.* FROM rosters r
       JOIN roster_members rm ON rm.roster_id = r.id
       JOIN roster_dates rd ON rd.roster_id = r.id AND rd.session_date = ?
       WHERE rm.member_id = ? AND r.active = 1
       ORDER BY LOWER(r.name)`
    )
    .all(dateISO, memberId);
}

module.exports = { getMemberRostersForDate, REASON_LABELS };

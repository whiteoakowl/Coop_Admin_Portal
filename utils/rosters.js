const db = require('../db');
const { weekdayOf } = require('./dates');
const { ensureDayRoster, addManualRosterMember } = require('./classSchedule');

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

// A real request: "even if a member doesn't have a schedule they should
// still be able to check in and out and they will automatically be
// added to the roster for that day." Shared by routes/kiosk.js's own
// /checkin/scan and routes/checkout.js's own /checkout/scan - each calls
// this once, only when getMemberRostersForDate already came back empty,
// then re-queries. Only meaningful on an actual meeting day (Monday/
// Wednesday) - there's no day-level roster to add anyone to otherwise.
// Idempotent (ensureDayRoster/addManualRosterMember/the roster_dates
// insert below are all already-exists-safe).
async function ensureMemberOnTodayRoster(member, today) {
  const dow = weekdayOf(today);
  const day = dow === 1 ? 'monday' : dow === 3 ? 'wednesday' : null;
  if (!day) return;
  // Admins share the Parent day-roster (member_type IN ('parent',
  // 'admin') is how the rest of this app already treats the two - see
  // utils/classSchedule.js's own comment on that pairing).
  const role = member.member_type === 'student' ? 'student' : 'parent';
  const rosterId = await ensureDayRoster(day, role);
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(rosterId, today);
  await addManualRosterMember(rosterId, member.id);
}

module.exports = { getMemberRostersForDate, ensureMemberOnTodayRoster, REASON_LABELS };

// Shared alert-list building blocks for both the Attendance page's own
// inline "Alerts" box (routes/admin-rosters.js) and the Home dashboard's
// Alert Log (routes/admin.js) - a real request: "the alert log should be
// the same as the daily alert log on the bottom of the attendance page,
// showing absent, late, class cancelation risk, substitutes needed.
// exactly the same." Both now read the identical functions for the
// identical day, so there's exactly one "what counts as an alert today"
// definition instead of two that can drift apart.
const db = require('../db');
const { byLastName } = require('./members');
const { REASON_LABELS } = require('./rosters');
const { DAYS } = require('./days');
const { weekdayOf } = require('./dates');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

// Only check a day whose weekday actually matches today - "today" isn't a
// real session for the other day, so there's nothing to alert on yet.
function todaysSessionDays(date) {
  return DAYS.filter((day) => weekdayOf(date) === DAY_WEEKDAY[day]);
}

// Every PARENT who submitted an Absence/Late form for today, one row per
// person (a parent submitting for two of their own kids' classes writes
// two attendance rows, one per roster, but that's still one alert per
// person) - the Alert Log's own signal that a form came in today, same
// as the dedicated Absence/Late Log tab an admin would otherwise have to
// go check manually. A real request: "absence alerts on the attendance
// page should only show parents names that are absent" - a student's own
// absence doesn't affect staffing/floater coverage the way a parent's
// does, so it's just noise here (a student marked absent on the very
// same form still shows up fine on the grid itself and in the Logs >
// Absence tab - this only trims the alert). Kept consistent with
// routes/admin-rosters.js's own absenceFormSubmissionsForRoster (the
// Attendance page's inline Alerts box), which applies the identical
// filter for the identical reason.
async function absenceFormAlertsForDay(day, date) {
  return db
    .prepare(
      `SELECT DISTINCT a.member_id AS "memberId", m.name AS "memberName", a.status, LOWER(m.name) AS "sortName"
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       JOIN rosters r ON r.id = a.roster_id
       WHERE a.session_date = ? AND a.source = 'absence_form' AND r.schedule_day = ? AND m.member_type = 'parent'
       ORDER BY "sortName"`
    )
    .all(date, day);
}

// Absence/Late form submissions on one roster for one date, split by
// status - drives the Attendance page's own inline "Alerts" box AND
// (as of the request above) the Home dashboard's Alert Log, both reading
// this exact same function now instead of each having their own slightly
// different query. A real request: "absence alerts on the attendance
// page should only show parents names that are absent" - a student's own
// absence doesn't affect staffing/floater coverage the way a parent's
// does, so it's just noise here (member_type = 'parent' only; students
// marked absent on the very same form still show up fine on the grid
// itself and in the Logs > Absence tab - this only trims the Alerts box).
async function absenceFormSubmissionsForRoster(rosterId, date) {
  if (!date) return { absences: [], lates: [] };
  const rows = (await db
    .prepare(
      `SELECT m.name AS name, a.status, a.reason_category AS "reasonCategory", a.reason_text AS "reasonText"
       FROM attendance a
       JOIN members m ON m.id = a.member_id
       WHERE a.roster_id = ? AND a.session_date = ? AND a.source = 'absence_form' AND m.member_type = 'parent'`
    )
    .all(rosterId, date))
    .sort(byLastName)
    .map((r) => ({
      memberName: r.name,
      status: r.status,
      reasonLabel: REASON_LABELS[r.reasonCategory] || '—',
      description: r.reasonText || '—',
    }));
  return {
    absences: rows.filter((r) => r.status === 'absent'),
    lates: rows.filter((r) => r.status === 'late'),
  };
}

module.exports = { todaysSessionDays, absenceFormAlertsForDay, absenceFormSubmissionsForRoster };

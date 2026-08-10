// Builds the same P/L/A attendance grid data structure used by the admin
// Attendance pages (routes/admin-rosters.js) and, now, the kiosk's
// read-only Class Check-In "View Class Attendance" screen (routes/
// kiosk-class-checkin.js) - pulled out to its own module specifically so
// both call sites share one implementation rather than the kiosk route
// growing its own copy of grid-building logic that could quietly drift
// from the admin one.
const db = require('../db');
const { byLastName } = require('./members');
const { familyOf } = require('./members');
const { arrivalDepartureLabels } = require('./schedule');
const { formatTime, formatDateLabel } = require('./dates');

// Every roster (each weekday's Parent/Student roster, every class's own
// roster) lists members alphabetically by last name, not first - see
// byLastName in utils/members.js.
function rosterMembers(rosterId) {
  return db
    .prepare(
      `SELECT m.*
       FROM members m
       JOIN roster_members rm ON rm.member_id = m.id
       WHERE rm.roster_id = ? AND m.active = 1`
    )
    .all(rosterId)
    .sort(byLastName);
}

function rosterDates(rosterId) {
  return db
    .prepare('SELECT session_date FROM roster_dates WHERE roster_id = ? ORDER BY session_date ASC')
    .all(rosterId)
    .map((r) => r.session_date);
}

// datesOverride lets a class roster borrow its dates from the day's
// Student roster instead of managing its own independent list - see
// admin-rosters.js's /rosters GET handler and kiosk-class-checkin.js's
// attendance view, both of which pass it in for exactly that reason.
// Attendance itself still lives under the class's own roster_id either
// way, only which dates count as real columns changes.
function buildRosterGridData(roster, datesOverride) {
  const dates = datesOverride || rosterDates(roster.id);
  const placeholders = dates.map(() => '?').join(',');
  const members = rosterMembers(roster.id);

  const attendanceRows = members.length && dates.length
    ? db
        .prepare(
          `SELECT member_id, session_date, status, check_in_time FROM attendance
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];
  const checkoutRows = members.length && dates.length
    ? db
        .prepare(
          `SELECT member_id, session_date, number, check_out_time FROM checkouts
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];

  const attendanceByKey = {};
  for (const r of attendanceRows) attendanceByKey[`${r.member_id}|${r.session_date}`] = r;
  const checkoutByKey = {};
  for (const r of checkoutRows) checkoutByKey[`${r.member_id}|${r.session_date}`] = r;

  const rows = members.map((m) => {
    const { arrival, departure } = arrivalDepartureLabels(m.id, roster.schedule_day);
    return {
      member: m,
      parentName: familyOf(m.id).map((p) => p.name).join(', ') || null,
      arrivalLabel: arrival,
      departureLabel: departure,
      cells: dates.map((d) => {
        const att = attendanceByKey[`${m.id}|${d}`];
        const out = checkoutByKey[`${m.id}|${d}`];
        if (!att) return { date: d, tag: null, checkInTime: null, checkOutTime: null, number: null };
        const tag = att.status === 'present' ? 'P' : att.status === 'late' ? 'L' : 'A';
        return {
          date: d,
          tag,
          status: att.status,
          checkInTime: formatTime(att.check_in_time),
          checkOutTime: out ? formatTime(out.check_out_time) : null,
          number: out ? out.number : null,
        };
      }),
    };
  });

  const summary = dates.map((d, i) => {
    let present = 0, late = 0, absent = 0;
    for (const row of rows) {
      const cell = row.cells[i];
      if (!cell || !cell.tag) continue;
      if (cell.tag === 'P') present++;
      else if (cell.tag === 'L') late++;
      else if (cell.tag === 'A') absent++;
    }
    return { present, late, absent };
  });

  return {
    dates,
    dateLabels: dates.map(formatDateLabel),
    rows,
    summary,
  };
}

module.exports = { rosterMembers, rosterDates, buildRosterGridData };

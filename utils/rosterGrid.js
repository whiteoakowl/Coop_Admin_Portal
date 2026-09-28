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
const { arrivalDepartureLabels, arrivalDepartureLabelsForMembers } = require('./schedule');
const { formatTime, formatDateLabel } = require('./dates');

// Every roster (each weekday's Parent/Student roster, every class's own
// roster) lists members alphabetically by last name, not first - see
// byLastName in utils/members.js.
async function rosterMembers(rosterId) {
  const members = await db
    .prepare(
      `SELECT m.*
       FROM members m
       JOIN roster_members rm ON rm.member_id = m.id
       WHERE rm.roster_id = ? AND m.active = 1`
    )
    .all(rosterId);
  return members.sort(byLastName);
}

async function rosterDates(rosterId) {
  const rows = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ? ORDER BY session_date ASC').all(rosterId);
  return rows.map((r) => r.session_date);
}

// datesOverride lets a class roster borrow its dates from the day's
// Student roster instead of managing its own independent list - see
// admin-rosters.js's /rosters GET handler and kiosk-class-checkin.js's
// attendance view, both of which pass it in for exactly that reason.
// Attendance itself still lives under the class's own roster_id either
// way, only which dates count as real columns changes.
async function buildRosterGridData(roster, datesOverride) {
  const dates = datesOverride || (await rosterDates(roster.id));
  const placeholders = dates.map(() => '?').join(',');
  const members = await rosterMembers(roster.id);

  const attendanceRows = members.length && dates.length
    ? await db
        .prepare(
          `SELECT member_id, session_date, status, check_in_time FROM attendance
           WHERE roster_id = ? AND session_date IN (${placeholders})`
        )
        .all(roster.id, ...dates)
    : [];
  const checkoutRows = members.length && dates.length
    ? await db
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

  // A batch lookup, computed once for the whole roster instead of once
  // per member - see arrivalDepartureLabelsForMembers's own comment for
  // why the per-member version was a severe N+1 at real scale. Falls
  // back to the (slower, but always-correct) per-member function only
  // for the rare roster whose schedule_day isn't 'monday'/'wednesday'.
  const isRealDay = roster.schedule_day === 'monday' || roster.schedule_day === 'wednesday';
  const labelsByMember = isRealDay
    ? await arrivalDepartureLabelsForMembers(members.map((m) => m.id), roster.schedule_day)
    : null;

  // Each member's ACTUALLY-SCANNED Setup/Cleanup task for that date - a
  // real bug report: "should only record the members team and number IF
  // they checked in and out with their setup/cleanup card. Just because
  // they were assigned on the setup/cleanup assignment page, it should
  // not show up on the attendance page." This used to read from
  // setup_task_assignments (Setup/Cleanup > Assignments tab), which is
  // just an admin's/auto-suggest's pick of who's SUPPOSED to do which
  // task - it exists the moment that page saves, whether or not the
  // member ever actually showed up and scanned their badge.
  //
  // A second real bug report, on a team set to "log on check in"
  // (setup_teams.task_scan_timing): "it should still record the setup
  // task badge number they completed on the Monday/Wednesday attendance
  // roster" - this used to read ONLY from checkouts.task_item_id
  // (supabase/migrations/20260824180500_attendance_task_scan.sql), which
  // only ever exists once a checkouts ROW exists at all, i.e. the member
  // has actually checked out. A "log on check in" member scans their real
  // badge immediately at check-in (routes/kiosk.js's own /checkin/task-
  // scan writes attendance.task_item_id right there), so someone still
  // present all day - no checkouts row yet - showed nothing on the
  // roster despite having genuinely scanned. attendance.task_item_id is
  // just as real a signal as checkouts.task_item_id - it's likewise only
  // ever written by an actual badge scan (never by the Assignments page),
  // just at check-in instead of checkout - so it's read here directly
  // instead of waiting for checkout to copy it over. checkouts.
  // task_item_id still wins once it exists (COALESCE), since that's the
  // more final record and is what a "log on check out" member's task -
  // never written to attendance at all - depends on exclusively. Only
  // meaningful for the day-level Parent/Student rosters (task_list_
  // sections is keyed by day, monday/wednesday, same as arrival/departure
  // above), not a per-class roster. Shown as "<team name>-#<n>", <n>
  // being the task's own display "Number" (its 1-indexed position within
  // its section - see utils/taskList.js's itemsForSection), computed here
  // with the same ROW_NUMBER()-over-position ordering so it always
  // matches what the Task List page itself shows for that task, not the
  // task's permanent barcode/id. Team name is whichever the section's own
  // linked setup_teams row is titled, falling back to the section's own
  // title when it isn't linked to a team at all - the same resolution
  // utils/taskList.js's badgeContextForSection already applies for
  // printed task badges, so this reads as the same "team" everywhere else
  // in the app calls it one (a real request: "instead of it just being #3
  // [...] it should say Team 1-#3").
  const cleanupByKey = {};
  if (isRealDay && members.length && dates.length) {
    const cleanupRows = await db
      .prepare(
        `SELECT merged.member_id, merged.session_date, numbered.number, COALESCE(st.title, tls.title) AS "teamName"
         FROM (
           SELECT a.member_id, a.session_date, COALESCE(c.task_item_id, a.task_item_id) AS "taskItemId"
           FROM attendance a
           LEFT JOIN checkouts c ON c.member_id = a.member_id AND c.roster_id = a.roster_id AND c.session_date = a.session_date
           WHERE a.roster_id = ? AND a.session_date IN (${placeholders})
         ) merged
         JOIN (
           SELECT id, section_id, ROW_NUMBER() OVER (PARTITION BY section_id ORDER BY position, id) AS number
           FROM task_list_items
           WHERE section_id IN (SELECT id FROM task_list_sections WHERE day = ?)
         ) numbered ON numbered.id = merged."taskItemId"
         JOIN task_list_sections tls ON tls.id = numbered.section_id
         LEFT JOIN setup_teams st ON st.id = tls.team_id
         WHERE merged."taskItemId" IS NOT NULL`
      )
      .all(roster.id, ...dates, roster.schedule_day);
    for (const r of cleanupRows) cleanupByKey[`${r.member_id}|${r.session_date}`] = { number: Number(r.number), teamName: r.teamName };
  }

  const rows = [];
  for (const m of members) {
    const { arrival, departure } = labelsByMember ? labelsByMember[m.id] : await arrivalDepartureLabels(m.id, roster.schedule_day);
    rows.push({
      member: m,
      parentName: (await familyOf(m.id)).map((p) => p.name).join(', ') || null,
      arrivalLabel: arrival,
      departureLabel: departure,
      cells: dates.map((d) => {
        const att = attendanceByKey[`${m.id}|${d}`];
        const out = checkoutByKey[`${m.id}|${d}`];
        const cleanupTask = cleanupByKey[`${m.id}|${d}`] || null;
        const cleanupTaskNumber = cleanupTask ? cleanupTask.number : null;
        const cleanupTeamName = cleanupTask ? cleanupTask.teamName : null;
        if (!att) return { date: d, tag: null, checkInTime: null, checkOutTime: null, number: null, cleanupTaskNumber, cleanupTeamName };
        const tag = att.status === 'present' ? 'P' : att.status === 'late' ? 'L' : 'A';
        return {
          date: d,
          tag,
          status: att.status,
          checkInTime: formatTime(att.check_in_time),
          checkOutTime: out ? formatTime(out.check_out_time) : null,
          number: out ? out.number : null,
          cleanupTaskNumber,
          cleanupTeamName,
        };
      }),
    });
  }

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

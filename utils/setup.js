const db = require('../db');
const { byLastName } = require('./members');
const { todayISO } = require('./dates');

async function teamsForDay(day) {
  return db
    .prepare(
      `SELECT st.*, m.name AS "leaderName"
       FROM setup_teams st
       LEFT JOIN members m ON m.id = st.leader_id AND m.active = 1
       WHERE st.day = ?
       ORDER BY LOWER(st.title)`
    )
    .all(day);
}

async function membersForTeam(teamId) {
  const members = await db
    .prepare(
      `SELECT m.* FROM members m
       JOIN setup_team_members stm ON stm.member_id = m.id
       WHERE stm.team_id = ? AND m.active = 1`
    )
    .all(teamId);
  return members.sort(byLastName);
}

async function setTeamLeader(teamId, leaderId) {
  await db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leaderId || null, teamId);
}

// The team card's Edit popup - title/description/leader all saved
// together in one Save action (see routes/admin-setup.js), unlike the
// old inline auto-submitting leader select this replaced.
async function updateTeam(teamId, fields) {
  await db.prepare('UPDATE setup_teams SET title = ?, description = ?, leader_id = ? WHERE id = ?').run(
    fields.title,
    fields.description || null,
    fields.leaderId || null,
    teamId
  );
}

// --- Setup/Cleanup Assignments (date-scoped, unlike the standing team
// roster above) - mirrors utils/volunteers.js's datesForList/
// membersForList/assignments shape, just keyed by `day` directly since
// setup_teams has no single "list" a date belongs to. ---

async function datesForDay(day) {
  return (await db.prepare('SELECT session_date FROM setup_dates WHERE day = ? ORDER BY session_date ASC').all(day)).map((r) => r.session_date);
}

async function addSetupDates(day, dates) {
  const insertDate = db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?) ON CONFLICT (day, session_date) DO NOTHING');
  for (const d of dates) await insertDate.run(day, d);
}

async function removeSetupDate(day, date) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM setup_dates WHERE day = ? AND session_date = ?').run(day, date);
    await tx.prepare('DELETE FROM setup_task_assignments WHERE day = ? AND session_date = ?').run(day, date);
  });
}

// { [memberId]: taskItemId } for one date - only members with a real
// suggestion set show up as keys, same "absent means not in the map"
// shape as familyAttendanceWindowsForDay elsewhere in this app.
async function taskAssignmentsForDate(day, date) {
  const rows = await db.prepare('SELECT member_id AS "memberId", task_item_id AS "taskItemId" FROM setup_task_assignments WHERE day = ? AND session_date = ?').all(day, date);
  const byMember = {};
  rows.forEach((r) => { if (r.taskItemId != null) byMember[r.memberId] = r.taskItemId; });
  return byMember;
}

// The suggestion dropdown auto-submits on change (same onchange="this.
// form.requestSubmit()" pattern as a Floater Teams rank select) -
// clearing it back to "no suggestion" (taskItemId falsy) deletes the row
// outright rather than storing a NULL, so taskAssignmentsForDate's "only
// real suggestions are keys" contract holds without a separate NULL check
// there.
async function setTaskAssignment(day, memberId, date, taskItemId) {
  if (!taskItemId) {
    await db.prepare('DELETE FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').run(day, memberId, date);
    return;
  }
  await db
    .prepare(
      `INSERT INTO setup_task_assignments (day, member_id, session_date, task_item_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, member_id, session_date) DO UPDATE SET task_item_id = excluded.task_item_id`
    )
    .run(day, memberId, date, taskItemId);
}

// Splits a day's dates into "today or later" (what the Assignments page's
// own date dropdown offers - there's no reason to suggest a task for a
// date that's already passed) and "before today" (what the Archive tab
// lists) - same today-boundary split as Floater Assignments' own
// archive/manage routes.
function splitDatesByToday(dates) {
  const today = todayISO();
  return { upcoming: dates.filter((d) => d >= today), past: dates.filter((d) => d < today) };
}

module.exports = {
  teamsForDay,
  membersForTeam,
  setTeamLeader,
  updateTeam,
  datesForDay,
  addSetupDates,
  removeSetupDate,
  taskAssignmentsForDate,
  setTaskAssignment,
  splitDatesByToday,
};

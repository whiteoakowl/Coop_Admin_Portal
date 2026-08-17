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

// { [memberId]: { taskItemId, taskItemId2 } } for one date - only members
// with at least one real suggestion set show up as keys, same "absent
// means not in the map" shape as familyAttendanceWindowsForDay elsewhere
// in this app; either slot on a present member can still individually be
// null (one job suggested, not two).
async function taskAssignmentsForDate(day, date) {
  const rows = await db
    .prepare(
      `SELECT member_id AS "memberId", task_item_id AS "taskItemId", task_item_id_2 AS "taskItemId2"
       FROM setup_task_assignments WHERE day = ? AND session_date = ?`
    )
    .all(day, date);
  const byMember = {};
  rows.forEach((r) => {
    if (r.taskItemId != null || r.taskItemId2 != null) byMember[r.memberId] = { taskItemId: r.taskItemId, taskItemId2: r.taskItemId2 };
  });
  return byMember;
}

// slot 1 or 2 - a real bug report: a small team routinely needs one
// member covering two jobs, but the Assignments page only ever offered a
// single "Suggested Task" dropdown per member. Each slot is its own
// column (task_item_id / task_item_id_2) rather than a list, matching the
// page's own fixed "always exactly two dropdowns" shape (see
// partials/setup-assignment-cards.ejs). The suggestion dropdown
// auto-submits on change (same onchange="this.form.requestSubmit()"
// pattern as a Floater Teams rank select) - clearing ONE slot back to "no
// suggestion" (taskItemId falsy) only nulls that column, not the whole
// row, so the other slot's own suggestion survives; the row itself is
// only deleted once BOTH slots are empty, keeping
// taskAssignmentsForDate's "only real suggestions are keys" contract
// without a separate all-null check there.
async function setTaskAssignment(day, memberId, date, slot, taskItemId) {
  const column = slot === 2 ? 'task_item_id_2' : 'task_item_id';
  const otherColumn = slot === 2 ? 'task_item_id' : 'task_item_id_2';
  if (!taskItemId) {
    const existing = await db
      .prepare(`SELECT ${otherColumn} AS "other" FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?`)
      .get(day, memberId, date);
    if (existing && existing.other != null) {
      await db.prepare(`UPDATE setup_task_assignments SET ${column} = NULL WHERE day = ? AND member_id = ? AND session_date = ?`).run(day, memberId, date);
    } else {
      await db.prepare('DELETE FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').run(day, memberId, date);
    }
    return;
  }
  await db
    .prepare(
      `INSERT INTO setup_task_assignments (day, member_id, session_date, ${column}) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, member_id, session_date) DO UPDATE SET ${column} = excluded.${column}`
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

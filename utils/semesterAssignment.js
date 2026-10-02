// A real request: "create a fall 2026 semester and connect all classes,
// floater assignments, setup cleanup, attendance, logs, everything on
// co-op admin portal. I don't want to lose any current data." Every
// semester-scoped "container" table (classes, volunteer_lists, setup_teams,
// task_list_sections, setup_dates, setup_task_assignments, class_schedules)
// can sit with semester_id = NULL until an admin tags it - this is the
// one-click, admin-facing sweep that tags everything still untagged with
// a chosen semester at once, extending the Classes-only tool
// (assignUnassignedClassesToSemester in utils/classSchedule.js) that
// already existed.
//
// Attendance, checkouts, and admin logs are intentionally NOT touched
// here - they're plain dated event records (already correctly scoped by
// their own session_date/timestamp), not schedule containers like the
// tables above, and have no semester_id column at all. Tagging a
// container with a semester never deletes or moves anything either: every
// roster/section/date/assignment under these containers hangs off the
// container's OWN id (class_id/volunteer_list_id/team_id/section_id),
// never touched here - only which semester the container itself is
// tagged under changes.
const db = require('../db');

async function countMissingSemesterData() {
  const [classes, volunteerLists, setupTeams, taskListSections, classSchedules] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM classes WHERE semester_id IS NULL').get(),
    db.prepare('SELECT COUNT(*) AS c FROM volunteer_lists WHERE semester_id IS NULL').get(),
    db.prepare('SELECT COUNT(*) AS c FROM setup_teams WHERE semester_id IS NULL').get(),
    db.prepare('SELECT COUNT(*) AS c FROM task_list_sections WHERE semester_id IS NULL').get(),
    db.prepare('SELECT COUNT(*) AS c FROM class_schedules WHERE semester_id IS NULL').get(),
  ]);
  return {
    classes: Number(classes.c),
    volunteerLists: Number(volunteerLists.c),
    setupTeams: Number(setupTeams.c),
    taskListSections: Number(taskListSections.c),
    classSchedules: Number(classSchedules.c),
  };
}

function totalMissing(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

// volunteer_lists/class_schedules/setup_dates/setup_task_assignments are
// each unique per (day[, extra keys], semester) - row-by-row with a
// conflict check so a day/date that already has a real row under the
// target semester (unusual, but possible if this tool's been run before,
// or a list was already lazily created under this semester some other
// way) is safely skipped and reported rather than crashing the whole
// sweep or silently colliding with - and losing - that row's own data.
// Keyed by matchColumns (its own natural key), not a surrogate id -
// setup_dates/setup_task_assignments have no id column of their own at
// all (composite primary keys only), unlike volunteer_lists/class_schedules.
async function reassignSkippingConflicts(table, matchColumns, semesterId) {
  const rows = await db.prepare(`SELECT ${matchColumns.join(', ')} FROM ${table} WHERE semester_id IS NULL`).all();
  const whereMatch = matchColumns.map((c) => `${c} = ?`).join(' AND ');
  let skipped = 0;
  for (const row of rows) {
    const keyValues = matchColumns.map((c) => row[c]);
    const conflict = await db.prepare(`SELECT 1 FROM ${table} WHERE ${whereMatch} AND semester_id = ?`).get(...keyValues, semesterId);
    if (conflict) {
      skipped++;
      continue;
    }
    await db.prepare(`UPDATE ${table} SET semester_id = ? WHERE ${whereMatch} AND semester_id IS NULL`).run(semesterId, ...keyValues);
  }
  return skipped;
}

async function assignMissingSemesterData(semesterId) {
  const before = await countMissingSemesterData();

  // classes/setup_teams/task_list_sections have no day+semester
  // uniqueness constraint of their own (many classes/teams/lists can
  // already share a day) - a plain bulk update is safe.
  await db.prepare('UPDATE classes SET semester_id = ? WHERE semester_id IS NULL').run(semesterId);
  await db.prepare('UPDATE setup_teams SET semester_id = ? WHERE semester_id IS NULL').run(semesterId);
  await db.prepare('UPDATE task_list_sections SET semester_id = ? WHERE semester_id IS NULL').run(semesterId);

  const skipped = {
    volunteerLists: await reassignSkippingConflicts('volunteer_lists', ['day'], semesterId),
    classSchedules: await reassignSkippingConflicts('class_schedules', ['day_of_week'], semesterId),
    setupDates: await reassignSkippingConflicts('setup_dates', ['day', 'session_date'], semesterId),
    setupTaskAssignments: await reassignSkippingConflicts('setup_task_assignments', ['day', 'member_id', 'session_date'], semesterId),
  };

  return { before, skipped, skippedTotal: totalMissing(skipped) };
}

module.exports = { countMissingSemesterData, totalMissing, assignMissingSemesterData };

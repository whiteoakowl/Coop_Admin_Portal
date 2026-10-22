// Staged, action-type-and-section-targeted class registration windows
// (see the registration_windows migrations' own header comments for the
// full rationale). A window can target any number of Schedule Grids
// (registration_window_schedules - none means every grid; a real request,
// "schedule grid should be a dropdown menu with check boxes to select
// multiple," moved this off a single class_schedule_id column onto its
// own join table, the same move Section got in the action-types
// migration), any number of Sections (registration_window_sections - none
// means everyone), and any combination of the four concrete self-service
// actions this app actually gates (none checked means every action, same
// "empty means unrestricted" rule sections/schedule grids already
// follow):
//   - open_for_parent_teacher: a parent/staff member signing themselves
//     up to teach (Co-op Teacher Portal's own /classes/:id/join, role=teacher)
//   - open_for_parent_assistant: same route, role=assistant
//   - open_for_parent_register_student: a parent registering their own
//     child (registerForClass, registrantType='parent')
//   - open_for_student_register_self: a student registering themselves
//     (registerForClass, registrantType='student')
// Shared by routes/admin-schedule.js (managing windows) and routes/
// parent-portal.js, routes/student-portal.js, routes/teacher-portal.js,
// utils/classRegistration.js (enforcing them at registration time).
const db = require('../db');

const ACTION_TYPE_COLUMNS = {
  parent_teacher: 'open_for_parent_teacher',
  parent_assistant: 'open_for_parent_assistant',
  parent_register_student: 'open_for_parent_register_student',
  student_register_self: 'open_for_student_register_self',
};

async function sectionIdsByWindow() {
  const rows = await db.prepare('SELECT window_id AS "windowId", section_id AS "sectionId" FROM registration_window_sections').all();
  const byWindow = {};
  rows.forEach((r) => {
    (byWindow[r.windowId] = byWindow[r.windowId] || []).push(r.sectionId);
  });
  return byWindow;
}

async function scheduleIdsByWindow() {
  const rows = await db.prepare('SELECT window_id AS "windowId", class_schedule_id AS "classScheduleId" FROM registration_window_schedules').all();
  const byWindow = {};
  rows.forEach((r) => {
    (byWindow[r.windowId] = byWindow[r.windowId] || []).push(r.classScheduleId);
  });
  return byWindow;
}

async function listWindows() {
  const windows = await db.prepare('SELECT * FROM registration_windows ORDER BY opens_at').all();
  const sectionRows = await db
    .prepare(
      `SELECT rws.window_id AS "windowId", s.name AS "sectionName" FROM registration_window_sections rws
       JOIN sections s ON s.id = rws.section_id
       ORDER BY s.name`
    )
    .all();
  const sectionNamesByWindow = {};
  sectionRows.forEach((r) => {
    (sectionNamesByWindow[r.windowId] = sectionNamesByWindow[r.windowId] || []).push(r.sectionName);
  });
  const scheduleRows = await db
    .prepare(
      `SELECT rwc.window_id AS "windowId", cs.title AS "scheduleTitle" FROM registration_window_schedules rwc
       JOIN class_schedules cs ON cs.id = rwc.class_schedule_id
       ORDER BY cs.title`
    )
    .all();
  const scheduleTitlesByWindow = {};
  scheduleRows.forEach((r) => {
    (scheduleTitlesByWindow[r.windowId] = scheduleTitlesByWindow[r.windowId] || []).push(r.scheduleTitle);
  });
  const sectionIdsByWindowMap = await sectionIdsByWindow();
  const scheduleIdsByWindowMap = await scheduleIdsByWindow();
  return windows.map((w) => ({
    ...w,
    sectionNames: sectionNamesByWindow[w.id] || [],
    sectionIds: sectionIdsByWindowMap[w.id] || [],
    scheduleTitles: scheduleTitlesByWindow[w.id] || [],
    scheduleIds: scheduleIdsByWindowMap[w.id] || [],
  }));
}

async function createWindow({ label, opensAt, closesAt, classScheduleIds, sectionIds, actionTypes }) {
  await db.withTransaction(async (tx) => {
    const columns = Object.values(ACTION_TYPE_COLUMNS);
    const values = Object.keys(ACTION_TYPE_COLUMNS).map((key) => (actionTypes || []).includes(key));
    const info = await tx
      .prepare(`INSERT INTO registration_windows (label, opens_at, closes_at, ${columns.join(', ')}) VALUES (?, ?, ?, ${columns.map(() => '?').join(', ')})`)
      .run(label, opensAt, closesAt || null, ...values);
    const windowId = info.lastInsertRowid;
    for (const sectionId of [...new Set(sectionIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_sections (window_id, section_id) VALUES (?, ?)').run(windowId, sectionId);
    }
    for (const classScheduleId of [...new Set(classScheduleIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_schedules (window_id, class_schedule_id) VALUES (?, ?)').run(windowId, classScheduleId);
    }
  });
}

async function updateWindow(id, { label, opensAt, closesAt, classScheduleIds, sectionIds, actionTypes }) {
  await db.withTransaction(async (tx) => {
    const columns = Object.values(ACTION_TYPE_COLUMNS);
    const values = Object.keys(ACTION_TYPE_COLUMNS).map((key) => (actionTypes || []).includes(key));
    await tx
      .prepare(`UPDATE registration_windows SET label = ?, opens_at = ?, closes_at = ?, ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(label, opensAt, closesAt || null, ...values, id);
    await tx.prepare('DELETE FROM registration_window_sections WHERE window_id = ?').run(id);
    for (const sectionId of [...new Set(sectionIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_sections (window_id, section_id) VALUES (?, ?)').run(id, sectionId);
    }
    await tx.prepare('DELETE FROM registration_window_schedules WHERE window_id = ?').run(id);
    for (const classScheduleId of [...new Set(classScheduleIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_schedules (window_id, class_schedule_id) VALUES (?, ?)').run(id, classScheduleId);
    }
  });
}

async function deleteWindow(id) {
  await db.prepare('DELETE FROM registration_windows WHERE id = ?').run(id);
}

// True once a window's own action-type toggles (none checked = every
// action) include the one being checked right now. actionType undefined
// (a page-level "is anything open at all" banner, not scoped to one
// specific action) counts a window as applicable if it's either
// unrestricted or restricted to at least one action.
function windowAppliesToAction(w, actionType) {
  const flags = Object.values(ACTION_TYPE_COLUMNS).map((col) => !!w[col]);
  const anySet = flags.some(Boolean);
  if (!anySet) return true;
  if (actionType === undefined) return true;
  return !!w[ACTION_TYPE_COLUMNS[actionType]];
}

// Whether class registration is currently open to this account for a
// given action. No windows defined at all means every class's own
// registration_open flag is the only gate (the original, pre-windows
// behavior) - a co-op that never sets up staged windows sees no change
// at all. Each of the 4 action-type checkboxes works independently - a
// real bug report: a window checking only "Parents can register for
// teaching positions" silently closed ordinary parent-student/
// student-self registration site-wide too, since nothing else ever
// mentioned those actions. So unless at least one window anywhere opts
// into gating this specific actionType (restricted to it, or left fully
// unrestricted), that action behaves exactly as if no windows existed at
// all - regardless of how many windows exist for OTHER actions. Once at
// least one window does cover this action, an account qualifies once
// it's inside a window that's unrestricted (no schedule grid/sections
// selected) or matches every one of the ones it does restrict.
// `classScheduleIds` (every Schedule Grid a class counts as belonging to,
// from classScheduleIdsForClass - a real class can match more than one
// grid when it's never been tagged with a specific semester, see that
// function's own comment) and `sectionIds` (the REGISTERING MEMBER's own
// Sections, from sectionIdsForMember - which parent/student is actually
// signing up, not the class's own separate lock-by-section restriction
// classSectionIds/memberSatisfiesRestriction already gate independently)
// narrow a window to one or more schedule grids / one or more Sections
// the member belongs to; omit either to check across all of them (used
// by page-level "is anything open" banners that aren't scoped to one
// class/member). A real request: "individual or multiple sections for
// members" - a window's own Section checkboxes now ask "is the person
// registering in one of these Sections," the same question Events/Chat's
// own Section-restriction already asks of a member, not "is the class
// itself locked to one of these Sections" (a window used to piggyback on
// the class's own lock instead of having its own member-facing meaning,
// which made a Section-scoped window silently do nothing for any class
// that had no section lock of its own). `actionType` narrows to one of
// the 4 keys in ACTION_TYPE_COLUMNS above; omit it for an unscoped "is
// anything open" check.
async function isRegistrationOpenForAccount(accountRoles, { classScheduleIds, sectionIds, actionType } = {}) {
  const windows = await db.prepare('SELECT * FROM registration_windows').all();
  if (windows.length === 0) return true;
  if (actionType !== undefined && !windows.some((w) => windowAppliesToAction(w, actionType))) return true;

  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const sectionsByWindow = await sectionIdsByWindow();
  const schedulesByWindow = await scheduleIdsByWindow();
  return windows.some((w) => {
    const requiredSchedules = schedulesByWindow[w.id] || [];
    if (requiredSchedules.length && classScheduleIds !== undefined && !classScheduleIds.some((id) => requiredSchedules.includes(id))) return false;
    const requiredSections = sectionsByWindow[w.id] || [];
    if (requiredSections.length && sectionIds !== undefined && !sectionIds.some((id) => requiredSections.includes(id))) return false;
    if (!windowAppliesToAction(w, actionType)) return false;
    if (nowText < w.opens_at) return false;
    if (w.closes_at && nowText >= w.closes_at) return false;
    return true;
  });
}

// The earliest not-yet-closed window that applies to this account,
// whether or not it has opened yet - lets the Classes page tell a parent
// *when* registration opens for them, not just that it isn't open yet.
// Null once no windows exist at all, or every window that applies to
// this account has already closed.
async function nextWindowForAccount(accountRoles, { classScheduleIds, sectionIds, actionType } = {}) {
  const windows = await db.prepare('SELECT * FROM registration_windows').all();
  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const sectionsByWindow = await sectionIdsByWindow();
  const schedulesByWindow = await scheduleIdsByWindow();
  const applicable = windows
    .filter((w) => {
      const requiredSchedules = schedulesByWindow[w.id] || [];
      return !requiredSchedules.length || classScheduleIds === undefined || classScheduleIds.some((id) => requiredSchedules.includes(id));
    })
    .filter((w) => {
      const requiredSections = sectionsByWindow[w.id] || [];
      return !requiredSections.length || sectionIds === undefined || sectionIds.some((id) => requiredSections.includes(id));
    })
    .filter((w) => windowAppliesToAction(w, actionType))
    .filter((w) => !w.closes_at || nowText < w.closes_at);
  if (applicable.length === 0) return null;
  return applicable.reduce((earliest, w) => (w.opens_at < earliest.opens_at ? w : earliest));
}

// A real request: "also the registration schedule settings [should copy
// over to new semesters]" - the same "clone from whichever semester most
// recently existed before this one" shape utils/taskList.js's own
// cloneTaskListFromMostRecentSemester already uses. Only windows tied to
// at least one SPECIFIC Schedule Grid belonging to the previous semester
// need a next-semester counterpart; a window with no Schedule Grid at all
// already applies to every semester by definition (isRegistrationOpen-
// ForAccount's own "none selected means every grid" rule), so re-cloning
// it would just create a confusing duplicate entry. Per a real request,
// this copies every field EXACTLY, opens_at/closes_at included - the
// admin is expected to edit each clone's dates afterward, same as they'd
// have to re-create it by hand otherwise. A window's own Schedule Grid
// id(s) can't be copied verbatim: the old semester's own grid rows don't
// exist in the new semester, so each one tied to the previous semester
// maps onto the new semester's own grid for the SAME day of week,
// dropping that one grid (not the whole window) if the new semester
// doesn't meet that day at all - a grid id belonging to some OTHER,
// unrelated semester (a window can target grids spanning more than one
// semester at once, unlike the old single-column version) carries
// through unchanged. A window ends up with no Schedule Grid left to
// clone onto at all is skipped entirely, same as the old "no matching
// day" skip.
async function cloneRegistrationWindowsFromMostRecentSemester(newSemesterId) {
  const previous = await db.prepare('SELECT id FROM semesters WHERE id != ? ORDER BY id DESC LIMIT 1').get(newSemesterId);
  if (!previous) return;
  const windows = await db
    .prepare(
      `SELECT DISTINCT w.* FROM registration_windows w
       JOIN registration_window_schedules rws ON rws.window_id = w.id
       JOIN class_schedules cs ON cs.id = rws.class_schedule_id
       WHERE cs.semester_id = ?`
    )
    .all(previous.id);
  if (windows.length === 0) return;

  const newSchedules = await db.prepare('SELECT * FROM class_schedules WHERE semester_id = ?').all(newSemesterId);
  const newScheduleIdByDay = new Map(newSchedules.map((s) => [s.day_of_week, s.id]));
  const allSchedules = await db.prepare('SELECT id, day_of_week, semester_id FROM class_schedules').all();
  const scheduleById = new Map(allSchedules.map((s) => [s.id, s]));
  const sectionsByWindow = await sectionIdsByWindow();
  const scheduleIdsByWindowMap = await scheduleIdsByWindow();

  for (const w of windows) {
    const oldScheduleIds = scheduleIdsByWindowMap[w.id] || [];
    const newScheduleIds = [];
    for (const oldId of oldScheduleIds) {
      const schedule = scheduleById.get(oldId);
      if (!schedule) continue;
      if (schedule.semester_id === previous.id) {
        const mapped = newScheduleIdByDay.get(schedule.day_of_week);
        if (mapped) newScheduleIds.push(mapped);
      } else {
        newScheduleIds.push(oldId);
      }
    }
    if (newScheduleIds.length === 0) continue;
    await createWindow({
      label: w.label,
      opensAt: w.opens_at,
      closesAt: w.closes_at,
      classScheduleIds: [...new Set(newScheduleIds)],
      sectionIds: sectionsByWindow[w.id] || [],
      actionTypes: Object.keys(ACTION_TYPE_COLUMNS).filter((key) => !!w[ACTION_TYPE_COLUMNS[key]]),
    });
  }
}

module.exports = {
  listWindows,
  createWindow,
  updateWindow,
  deleteWindow,
  isRegistrationOpenForAccount,
  nextWindowForAccount,
  cloneRegistrationWindowsFromMostRecentSemester,
};

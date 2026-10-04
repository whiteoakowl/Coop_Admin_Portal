// Staged, action-type-and-section-targeted class registration windows
// (see the registration_windows migrations' own header comments for the
// full rationale). A window can target one specific Schedule Grid
// (class_schedules row - null means every grid), any number of Sections
// (registration_window_sections - none means everyone), and any
// combination of the four concrete self-service actions this app
// actually gates (none checked means every action, same "empty means
// unrestricted" rule sections/schedule grid already follow):
//   - open_for_parent_teacher: a parent/staff member signing themselves
//     up to teach (Teacher Portal's own /classes/:id/join, role=teacher)
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

async function listWindows() {
  const windows = await db
    .prepare(
      `SELECT w.*, cs.title AS "scheduleTitle" FROM registration_windows w
       LEFT JOIN class_schedules cs ON cs.id = w.class_schedule_id
       ORDER BY w.opens_at`
    )
    .all();
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
  const sectionIdsByWindowMap = await sectionIdsByWindow();
  return windows.map((w) => ({ ...w, sectionNames: sectionNamesByWindow[w.id] || [], sectionIds: sectionIdsByWindowMap[w.id] || [] }));
}

async function createWindow({ label, opensAt, closesAt, classScheduleId, sectionIds, actionTypes }) {
  await db.withTransaction(async (tx) => {
    const columns = Object.values(ACTION_TYPE_COLUMNS);
    const values = Object.keys(ACTION_TYPE_COLUMNS).map((key) => (actionTypes || []).includes(key));
    const info = await tx
      .prepare(
        `INSERT INTO registration_windows (label, opens_at, closes_at, class_schedule_id, ${columns.join(', ')})
         VALUES (?, ?, ?, ?, ${columns.map(() => '?').join(', ')})`
      )
      .run(label, opensAt, closesAt || null, classScheduleId || null, ...values);
    const windowId = info.lastInsertRowid;
    for (const sectionId of [...new Set(sectionIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_sections (window_id, section_id) VALUES (?, ?)').run(windowId, sectionId);
    }
  });
}

async function updateWindow(id, { label, opensAt, closesAt, classScheduleId, sectionIds, actionTypes }) {
  await db.withTransaction(async (tx) => {
    const columns = Object.values(ACTION_TYPE_COLUMNS);
    const values = Object.keys(ACTION_TYPE_COLUMNS).map((key) => (actionTypes || []).includes(key));
    await tx
      .prepare(
        `UPDATE registration_windows SET label = ?, opens_at = ?, closes_at = ?, class_schedule_id = ?, ${columns.map((c) => `${c} = ?`).join(', ')}
         WHERE id = ?`
      )
      .run(label, opensAt, closesAt || null, classScheduleId || null, ...values, id);
    await tx.prepare('DELETE FROM registration_window_sections WHERE window_id = ?').run(id);
    for (const sectionId of [...new Set(sectionIds || [])]) {
      await tx.prepare('INSERT INTO registration_window_sections (window_id, section_id) VALUES (?, ?)').run(id, sectionId);
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
// at all. Once at least one window exists, an account qualifies once
// it's inside a window that's unrestricted (no schedule grid/sections/
// action types selected) or matches every one of the ones it does
// restrict. `classScheduleId` (the CLASS's own Schedule Grid, from
// classScheduleIdForClass - not the member's) and `sectionIds` (the
// CLASS's own section restriction, from classSectionIds) narrow a window
// to one schedule grid / one Sections group; omit either to check across
// all of them (used by page-level "is anything open" banners that aren't
// scoped to one class). `actionType` narrows to one of the 4 keys in
// ACTION_TYPE_COLUMNS above; omit it for an unscoped "is anything open"
// check.
async function isRegistrationOpenForAccount(accountRoles, { classScheduleId, sectionIds, actionType } = {}) {
  const windows = await db.prepare('SELECT * FROM registration_windows').all();
  if (windows.length === 0) return true;

  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const sectionsByWindow = await sectionIdsByWindow();
  return windows.some((w) => {
    if (w.class_schedule_id && classScheduleId !== undefined && w.class_schedule_id !== classScheduleId) return false;
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
async function nextWindowForAccount(accountRoles, { classScheduleId, sectionIds, actionType } = {}) {
  const windows = await db.prepare('SELECT * FROM registration_windows').all();
  const nowText = (await db.prepare('SELECT now_text() AS now').get()).now;
  const sectionsByWindow = await sectionIdsByWindow();
  const applicable = windows
    .filter((w) => !w.class_schedule_id || classScheduleId === undefined || w.class_schedule_id === classScheduleId)
    .filter((w) => {
      const requiredSections = sectionsByWindow[w.id] || [];
      return !requiredSections.length || sectionIds === undefined || sectionIds.some((id) => requiredSections.includes(id));
    })
    .filter((w) => windowAppliesToAction(w, actionType))
    .filter((w) => !w.closes_at || nowText < w.closes_at);
  if (applicable.length === 0) return null;
  return applicable.reduce((earliest, w) => (w.opens_at < earliest.opens_at ? w : earliest));
}

module.exports = { listWindows, createWindow, updateWindow, deleteWindow, isRegistrationOpenForAccount, nextWindowForAccount };

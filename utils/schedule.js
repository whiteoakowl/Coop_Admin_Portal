const db = require('../db');
const {
  familyAttendanceWindowsForDay,
  liveMemberScheduleRowsForDay,
  minutesToClockLabelLocal,
  listActiveClassDays,
} = require('./classSchedule');
const { byLastName } = require('./members');

const CLASS_NUMBERS = [1, 2, 3, 4];

// Always returns exactly 4 rows (class_number 1-4) for a day, filling any
// missing class number with a blank placeholder row so the UI/print layout
// never has to special-case "fewer than 4 classes".
function fourRows(rows) {
  const byNumber = {};
  rows.forEach((r) => { byNumber[r.class_number] = r; });
  return CLASS_NUMBERS.map((n) => byNumber[n] || { class_number: n, time: '', class_name: '', room: '', teacher: '' });
}

// A single member's full schedule, one entry per active day (Day
// Settings - "Full 7 day expansion..." widened this from a fixed Monday +
// Wednesday pair), computed live (see liveMemberScheduleRowsForDay's own
// comment for why - every "member schedule" display surface funnels
// through this one function or scheduleList below, so fixing it here
// fixes all of them at once, with no separate "did someone resync" step
// to go stale). Fine to call once per member for a single lookup (the
// member profile's Schedule popup, a family's few members); a caller
// iterating over many members at once should use scheduleList instead,
// which computes each day's live rows ONCE and reuses them, rather than
// recomputing the whole day per member. Returns { byDay: { [day]:
// fourRows }, activeDays, lastUpdated } - byDay rather than schedule, so a
// caller naming its own result `schedule` (most do) doesn't end up with
// the confusingly doubled-up schedule.schedule.
async function getMemberSchedule(memberId) {
  const activeDays = await listActiveClassDays();
  const rowsByDay = await Promise.all(activeDays.map((d) => liveMemberScheduleRowsForDay(d)));
  const byDay = {};
  activeDays.forEach((d, i) => { byDay[d] = fourRows(Object.values(rowsByDay[i][memberId] || {})); });
  return { byDay, activeDays, lastUpdated: null };
}

// Batch version of getMemberSchedule for an arbitrary list of member ids -
// not necessarily "every active member" the way scheduleList's own
// per-member computation is, so a bulk print flow with its own specific
// selection (Design/Print's Name Tags + Schedule Cards, Front & Back
// Duplex, and the per-member Cards dialog - see utils/cardPairs.js) can
// still compute each day's live schedule ONCE regardless of how many
// members are in that selection, instead of once per member. A real bug
// report: printing ~800 cards timed out - the exact same severe N+1 shape
// routes/admin-schedule.js's own print-cards route was already fixed for
// (see its own comment), just never applied to cardPairs.js. Returns
// { [memberId]: { [day]: fourRows } }.
async function schedulesForMembers(memberIds) {
  const activeDays = await listActiveClassDays();
  const rowsByDay = await Promise.all(activeDays.map((d) => liveMemberScheduleRowsForDay(d)));
  const result = {};
  for (const memberId of memberIds) {
    const schedule = {};
    activeDays.forEach((d, i) => { schedule[d] = fourRows(Object.values(rowsByDay[i][memberId] || {})); });
    result[memberId] = schedule;
  }
  return result;
}

function rowIsBlank(row) {
  return !row.time && !row.class_name && !row.room && !row.teacher;
}

// Parses a single "9:00 AM" / "1:15 PM" clock string into minutes-since-
// midnight for comparison. Returns null if it doesn't match (freeform
// admin-typed text isn't guaranteed to parse). Tolerates an optional
// ":SS" seconds component (discarded, never needed at minute
// resolution) - "10:00:00 AM" is exactly what a spreadsheet cell
// formatted as Excel's h:mm:ss AM/PM shows once utils/spreadsheetWorker.js
// reads its formatted text instead of a raw serial (see that file's own
// comment); without this, that real, common spreadsheet format would
// still fail to parse even after that fix.
function parseClockMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/.exec((raw || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const period = m[3] ? m[3].toUpperCase() : null;
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

// Splits a "9:00 - 9:45 AM" class time into its start/end pieces. If only
// the end has an AM/PM suffix, it's borrowed onto the start (same
// assumption public/js/name-tag-render-core.js makes for schedule cards -
// both halves of a class period are the same half of the day).
function splitTimeRange(raw) {
  const value = (raw || '').trim();
  const dashIndex = value.indexOf('-');
  if (dashIndex === -1) return { startRaw: value, endRaw: value };
  const start = value.slice(0, dashIndex).trim();
  let end = value.slice(dashIndex + 1).trim();
  const endAmPm = /(AM|PM|am|pm)\s*$/.exec(end);
  let startRaw = start;
  if (endAmPm && !/(AM|PM|am|pm)\s*$/.test(start)) startRaw += ' ' + endAmPm[1].toUpperCase();
  return { startRaw, endRaw: end };
}

// A family's earliest class start and latest class end - used to auto-fill
// Arrival/Departure on the roster view instead of requiring an admin to
// type them in by hand. Computed LIVE from current class enrollment/
// staffing/floater data (utils/classSchedule.js's
// familyAttendanceWindowsForDay) every time this is called, rather than
// read back from the separately-cached member_schedules table - that
// table only gets rebuilt when enrollment/staffing/floater assignments
// actually change, so a family whose schedule hasn't been touched since a
// fix to this computation landed would otherwise keep showing whatever
// was cached under the old logic. `day` scopes this to one roster's own
// day, matching that day's roster to that day's own schedule; omit it (or
// pass a day that isn't currently active) to fall back to every active
// day combined. Returns null for either half if nothing on the schedule
// resolves to a real time.
async function arrivalDepartureLabels(memberId, day) {
  const activeDays = await listActiveClassDays();
  const days = activeDays.includes(day) ? [day] : activeDays;
  let earliest = null;
  let latest = null;
  for (const d of days) {
    const window = (await familyAttendanceWindowsForDay(d))[memberId];
    if (!window) continue;
    if (earliest == null || window.start < earliest) earliest = window.start;
    if (latest == null || window.end > latest) latest = window.end;
  }
  return {
    arrival: earliest != null ? minutesToClockLabelLocal(earliest) : null,
    departure: latest != null ? minutesToClockLabelLocal(latest) : null,
  };
}

// Batch version of arrivalDepartureLabels for a whole roster's worth of
// members at once - computes familyAttendanceWindowsForDay(day) exactly
// ONCE and reuses it for every member, instead of a caller looping
// arrivalDepartureLabels(memberId, day) per member, which redundantly
// re-ran that same full-day computation (classes, enrollments, staffing,
// and every floater section's membership) from scratch for every single
// row. That N+1 was invisible against PGlite's local, in-process test
// data but made a real Postgres-backed roster with hundreds of members
// severely slow (reported live: the Attendance page became unresponsive).
// Only handles a single real day ('monday' or 'wednesday') - unlike
// arrivalDepartureLabels, there's no "combine both days" fallback, since
// every roster's own schedule_day is always one of those two; callers
// with anything else should fall back to arrivalDepartureLabels per
// member instead. Returns { [memberId]: { arrival, departure } }.
async function arrivalDepartureLabelsForMembers(memberIds, day) {
  const windowByMember = await familyAttendanceWindowsForDay(day);
  const result = {};
  for (const memberId of memberIds) {
    const window = windowByMember[memberId];
    result[memberId] = {
      arrival: window ? minutesToClockLabelLocal(window.start) : null,
      departure: window ? minutesToClockLabelLocal(window.end) : null,
    };
  }
  return result;
}

// 'none' - no classes at all. 'partial' - some classes filled in, but not
// every active day's 4 slots. 'complete' - every slot filled.
function scheduleStatus(scheduleByDay) {
  const all = Object.values(scheduleByDay).flat();
  const filled = all.filter((r) => !rowIsBlank(r));
  if (filled.length === 0) return 'none';
  if (filled.length === all.length) return 'complete';
  return 'partial';
}

const STATUS_LABELS = { none: 'No Schedule', partial: 'Incomplete', complete: 'Complete' };

// One row per active student, joined with their schedule summary, for the
// Class Schedules table. Filters are all optional/AND-combined.
async function scheduleList(filters) {
  filters = filters || {};
  let members = (await db.prepare('SELECT * FROM members WHERE active = 1').all()).sort(byLastName);

  if (filters.search) {
    const q = filters.search.toLowerCase();
    members = members.filter((m) => m.name.toLowerCase().includes(q));
  }
  if (filters.grade) {
    members = members.filter((m) => (m.grade_level || '') === filters.grade);
  }
  if (filters.rosterId) {
    const memberIds = new Set(
      (await db.prepare('SELECT member_id FROM roster_members WHERE roster_id = ?').all(filters.rosterId)).map((r) => r.member_id)
    );
    members = members.filter((m) => memberIds.has(m.id));
  }
  if (filters.memberId) {
    members = members.filter((m) => m.id === filters.memberId);
  }
  if (filters.familyId) {
    members = members.filter((m) => m.family_id === filters.familyId);
  }
  if (filters.memberType) {
    // Accepts either a single type or an array - the Schedules page's
    // Parent tab passes ['parent', 'admin'] so admin/leader members show
    // up there too (a real bug report: "when viewing parent schedules
    // under parent tab it won't show admins" - wherever there's a parent
    // filter site-wide, admins should still be included).
    const types = Array.isArray(filters.memberType) ? filters.memberType : [filters.memberType];
    members = members.filter((m) => types.includes(m.member_type));
  }

  // Computed once for the whole filtered list, not once per member -
  // getMemberSchedule's own per-member version would otherwise redo each
  // day's full live computation (every class/enrollment/staffing/floater
  // row) once per member, the same severe N+1 shape already fixed once
  // for Arrival/Departure (see arrivalDepartureLabelsForMembers's own
  // comment) - this page can list every active member at once.
  const activeDays = await listActiveClassDays();
  const rowsByDay = await Promise.all(activeDays.map((d) => liveMemberScheduleRowsForDay(d)));
  let rows = members.map((m) => {
    const byDay = {};
    activeDays.forEach((d, i) => { byDay[d] = fourRows(Object.values(rowsByDay[i][m.id] || {})); });
    return { member: m, byDay, activeDays, lastUpdated: null, status: scheduleStatus(byDay) };
  });

  if (activeDays.includes(filters.day)) {
    rows = rows.filter((r) => r.byDay[filters.day].some((c) => !rowIsBlank(c)));
  }
  if (filters.teacher) {
    rows = rows.filter((r) => Object.values(r.byDay).flat().some((c) => c.teacher === filters.teacher));
  }
  if (filters.room) {
    rows = rows.filter((r) => Object.values(r.byDay).flat().some((c) => c.room === filters.room));
  }
  if (filters.className) {
    rows = rows.filter((r) => Object.values(r.byDay).flat().some((c) => c.class_name === filters.className));
  }
  if (filters.status) {
    rows = rows.filter((r) => r.status === filters.status);
  }

  return rows;
}

module.exports = {
  CLASS_NUMBERS,
  STATUS_LABELS,
  getMemberSchedule,
  schedulesForMembers,
  fourRows,
  rowIsBlank,
  scheduleStatus,
  scheduleList,
  arrivalDepartureLabels,
  arrivalDepartureLabelsForMembers,
  parseClockMinutes,
  splitTimeRange,
};

const db = require('../db');
const { DAYS, DAY_LABELS } = require('./days');
const {
  syncClassRosterMembers,
  syncDayMemberRosters,
  familyAttendanceWindowsForDay,
  liveMemberScheduleRowsForDay,
  minutesToClockLabelLocal,
} = require('./classSchedule');

const CLASS_NUMBERS = [1, 2, 3, 4];

// Always returns exactly 4 rows (class_number 1-4) for a day, filling any
// missing class number with a blank placeholder row so the UI/print layout
// never has to special-case "fewer than 4 classes".
function fourRows(rows) {
  const byNumber = {};
  rows.forEach((r) => { byNumber[r.class_number] = r; });
  return CLASS_NUMBERS.map((n) => byNumber[n] || { class_number: n, time: '', class_name: '', room: '', teacher: '' });
}

// A single member's Monday + Wednesday schedule, computed live (see
// liveMemberScheduleRowsForDay's own comment for why - every "member
// schedule" display surface funnels through this one function or
// scheduleList below, so fixing it here fixes all of them at once, with
// no separate "did someone resync" step to go stale). Fine to call once
// per member for a single lookup (the member profile's Schedule popup, a
// family's few members); a caller iterating over many members at once
// should use scheduleList instead, which computes each day's live rows
// ONCE and reuses them, rather than recomputing the whole day per member.
async function getMemberSchedule(memberId) {
  const [mondayRows, wednesdayRows] = await Promise.all([liveMemberScheduleRowsForDay('monday'), liveMemberScheduleRowsForDay('wednesday')]);
  const monday = fourRows(Object.values(mondayRows[memberId] || {}));
  const wednesday = fourRows(Object.values(wednesdayRows[memberId] || {}));
  return { monday, wednesday, lastUpdated: null };
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
// { [memberId]: { monday, wednesday } }.
async function schedulesForMembers(memberIds) {
  const [mondayRows, wednesdayRows] = await Promise.all([liveMemberScheduleRowsForDay('monday'), liveMemberScheduleRowsForDay('wednesday')]);
  const result = {};
  for (const memberId of memberIds) {
    result[memberId] = {
      monday: fourRows(Object.values(mondayRows[memberId] || {})),
      wednesday: fourRows(Object.values(wednesdayRows[memberId] || {})),
    };
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
// was cached under the old logic. `day` ('monday' or 'wednesday') scopes
// this to the roster's own day, matching Monday rosters to the Monday
// schedule and Wednesday rosters to the Wednesday schedule; omit it (or
// pass anything else) to fall back to both days combined. Returns null
// for either half if nothing on the schedule resolves to a real time.
async function arrivalDepartureLabels(memberId, day) {
  const days = day === 'monday' || day === 'wednesday' ? [day] : DAYS;
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
// all 8 (4 Monday + 4 Wednesday) slots. 'complete' - every slot filled.
function scheduleStatus(monday, wednesday) {
  const all = [...monday, ...wednesday];
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
  let members = await db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY LOWER(name)').all();

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
    members = members.filter((m) => m.member_type === filters.memberType);
  }

  // Computed once for the whole filtered list, not once per member -
  // getMemberSchedule's own per-member version would otherwise redo each
  // day's full live computation (every class/enrollment/staffing/floater
  // row) once per member, the same severe N+1 shape already fixed once
  // for Arrival/Departure (see arrivalDepartureLabelsForMembers's own
  // comment) - this page can list every active member at once.
  const [mondayRows, wednesdayRows] = await Promise.all([liveMemberScheduleRowsForDay('monday'), liveMemberScheduleRowsForDay('wednesday')]);
  let rows = members.map((m) => {
    const monday = fourRows(Object.values(mondayRows[m.id] || {}));
    const wednesday = fourRows(Object.values(wednesdayRows[m.id] || {}));
    return { member: m, monday, wednesday, lastUpdated: null, status: scheduleStatus(monday, wednesday) };
  });

  if (filters.day === 'monday') rows = rows.filter((r) => r.monday.some((c) => !rowIsBlank(c)));
  if (filters.day === 'wednesday') rows = rows.filter((r) => r.wednesday.some((c) => !rowIsBlank(c)));
  if (filters.teacher) {
    rows = rows.filter((r) => [...r.monday, ...r.wednesday].some((c) => c.teacher === filters.teacher));
  }
  if (filters.room) {
    rows = rows.filter((r) => [...r.monday, ...r.wednesday].some((c) => c.room === filters.room));
  }
  if (filters.className) {
    rows = rows.filter((r) => [...r.monday, ...r.wednesday].some((c) => c.class_name === filters.className));
  }
  if (filters.status) {
    rows = rows.filter((r) => r.status === filters.status);
  }

  return rows;
}

// One line per day summarizing a member's current schedule, for the
// snapshot archiveMemberSchedules saves before clearing it - not meant to
// be parsed back, just a readable historical record (same spirit as
// class_schedule_archives flattening teachers/assistants to plain text).
function summarizeScheduleDay(rows) {
  const text = rows
    .filter((r) => !rowIsBlank(r))
    .map((r) => [r.time, r.class_name, r.room].filter(Boolean).join(' - '))
    .join('; ');
  return text || null;
}

// Archives the given members' current schedules (one row per member in
// member_schedule_archives, see its own migration comment) and unenrolls
// each one from every class they're currently on - as a student,
// class_enrollments; as a parent, class_staff. This is the Student/Parent
// Schedules tab's own equivalent of archiveClasses (utils/classSchedule.js):
// clearing everyone's schedule before importing a new term's file, without
// losing the record of what they were on. Days actually touched are
// resynced once each at the end (not once per member/class) for the same
// reason the Class Schedule Import batches it - see addStaff's own comment
// on skipSync. Returns how many members were archived.
//
// A real live-reported timeout: the original version called
// getMemberSchedule(memberId) once PER member - and that function redoes
// each day's ENTIRE live computation (every class's enrollment/staffing,
// every floater section) from scratch on every call (see
// liveMemberScheduleRowsForDay's own comment on why - it's built once and
// reused for a whole page elsewhere, e.g. scheduleList). Fine for the one
// member a real page normally archives at a time; with the Select-All-
// across-all-pages fix landing at the same time this bug was found (now
// a batch can genuinely be hundreds of members), that became hundreds of
// full-day recomputations against a real, network-latency-bound
// Postgres connection - long enough to hit Netlify's function timeout
// before the request ever finished. Fixed the same way
// arrivalDepartureLabelsForMembers already fixed the identical shape of
// N+1 for Arrival/Departure: compute both days' live rows ONCE for the
// whole batch, then reuse them per member.
async function archiveMemberSchedules(memberIds) {
  if (memberIds.length === 0) return 0;
  const placeholders = memberIds.map(() => '?').join(',');
  const members = await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds);
  if (members.length === 0) return 0;

  const [mondayRows, wednesdayRows] = await Promise.all([liveMemberScheduleRowsForDay('monday'), liveMemberScheduleRowsForDay('wednesday')]);

  const touchedDays = new Set();
  const studentIds = [];
  const parentIds = [];
  const archiveRows = members.map((member) => {
    const monday = fourRows(Object.values(mondayRows[member.id] || {}));
    const wednesday = fourRows(Object.values(wednesdayRows[member.id] || {}));
    if (monday.some((r) => !rowIsBlank(r))) touchedDays.add('monday');
    if (wednesday.some((r) => !rowIsBlank(r))) touchedDays.add('wednesday');
    (member.member_type === 'student' ? studentIds : parentIds).push(member.id);
    return { member, monday, wednesday };
  });

  // Every class any archived student is currently enrolled in, gathered
  // BEFORE the bulk delete below removes the rows that would otherwise
  // tell us - synced once per distinct class after unenrolling everyone,
  // not once per (student, class) pair, since more than one archived
  // student commonly shares the same class.
  const classIds = new Set();
  if (studentIds.length) {
    const studentPlaceholders = studentIds.map(() => '?').join(',');
    (await db.prepare(`SELECT DISTINCT class_id FROM class_enrollments WHERE student_id IN (${studentPlaceholders})`).all(...studentIds)).forEach(
      (r) => classIds.add(r.class_id)
    );
  }

  await db.withTransaction(async (tx) => {
    for (const { member, monday, wednesday } of archiveRows) {
      await tx
        .prepare(
          `INSERT INTO member_schedule_archives (member_id, member_name, member_type, monday_schedule, wednesday_schedule)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(member.id, member.name, member.member_type, summarizeScheduleDay(monday), summarizeScheduleDay(wednesday));
    }
    if (studentIds.length) {
      const studentPlaceholders = studentIds.map(() => '?').join(',');
      await tx.prepare(`DELETE FROM class_enrollments WHERE student_id IN (${studentPlaceholders})`).run(...studentIds);
    }
    if (parentIds.length) {
      const parentPlaceholders = parentIds.map(() => '?').join(',');
      await tx.prepare(`DELETE FROM class_staff WHERE member_id IN (${parentPlaceholders})`).run(...parentIds);
    }
  });

  // Both sync steps read back the rows the transaction above just wrote/
  // deleted, so they have to run after it commits, not inside it -
  // syncClassRosterMembers/syncDayMemberRosters each use the module's own
  // top-level db connection, not the transaction's dedicated one (see
  // db/postgres.js's own header comment on why a query inside
  // withTransaction MUST go through the tx handle it hands you - anything
  // that doesn't is on a different connection, and would either miss the
  // still-uncommitted deletes above or, worse, race the commit itself).
  for (const classId of classIds) await syncClassRosterMembers(classId);
  for (const day of touchedDays) await syncDayMemberRosters(day);
  return members.length;
}

async function listMemberScheduleArchives(memberType) {
  return db
    .prepare('SELECT * FROM member_schedule_archives WHERE member_type = ? ORDER BY archived_at DESC, id DESC')
    .all(memberType);
}

async function deleteMemberScheduleArchive(id) {
  await db.prepare('DELETE FROM member_schedule_archives WHERE id = ?').run(id);
}

async function deleteAllMemberScheduleArchives(memberType) {
  const result = await db.prepare('DELETE FROM member_schedule_archives WHERE member_type = ?').run(memberType);
  return result.changes;
}

module.exports = {
  DAYS,
  CLASS_NUMBERS,
  DAY_LABELS,
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
  archiveMemberSchedules,
  listMemberScheduleArchives,
  deleteMemberScheduleArchive,
  deleteAllMemberScheduleArchives,
};

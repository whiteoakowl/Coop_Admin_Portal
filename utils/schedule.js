const db = require('../db');
const { DAYS, DAY_LABELS } = require('./days');
const { familyOf } = require('./members');
const { syncClassRosterMembers, syncDayMemberRosters } = require('./classSchedule');

const CLASS_NUMBERS = [1, 2, 3, 4];

// Always returns exactly 4 rows (class_number 1-4) for a day, filling any
// missing class number with a blank placeholder row so the UI/print layout
// never has to special-case "fewer than 4 classes".
function fourRows(rows) {
  const byNumber = {};
  rows.forEach((r) => { byNumber[r.class_number] = r; });
  return CLASS_NUMBERS.map((n) => byNumber[n] || { class_number: n, time: '', class_name: '', room: '', teacher: '' });
}

async function getMemberSchedule(memberId) {
  const rows = await db.prepare('SELECT * FROM member_schedules WHERE member_id = ? ORDER BY day, class_number').all(memberId);
  const monday = fourRows(rows.filter((r) => r.day === 'monday'));
  const wednesday = fourRows(rows.filter((r) => r.day === 'wednesday'));
  const lastUpdated = rows.length ? rows.map((r) => r.updated_at).sort().slice(-1)[0] : null;
  return { monday, wednesday, lastUpdated };
}

function rowIsBlank(row) {
  return !row.time && !row.class_name && !row.room && !row.teacher;
}

// Parses a single "9:00 AM" / "1:15 PM" clock string into minutes-since-
// midnight for comparison. Returns null if it doesn't match (freeform
// admin-typed text isn't guaranteed to parse).
function parseClockMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/.exec((raw || '').trim());
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
// type them in by hand. Reads memberId's own schedule plus every other
// member of their family (a parent's drop-off/pick-up is set by whichever
// of their kids' classes runs earliest/latest, not just their own), so
// every member of one family lands on the same arrival/departure pair.
// `day` ('monday' or 'wednesday') scopes this to the roster's own day,
// matching Monday rosters to the Monday schedule and Wednesday rosters to
// the Wednesday schedule; omit it (or pass anything else) to fall back to
// both days combined. Returns raw label strings (whatever the admin typed
// for that class's time, not reformatted) or null if nothing on the
// schedule parses.
async function arrivalDepartureLabels(memberId, day) {
  const familyIds = [memberId, ...(await familyOf(memberId)).map((m) => m.id)];
  let earliest = null;
  let latest = null;
  for (const id of familyIds) {
    const { monday, wednesday } = await getMemberSchedule(id);
    const rows = day === 'monday' ? monday : day === 'wednesday' ? wednesday : [...monday, ...wednesday];
    rows.forEach((row) => {
      if (!row.time) return;
      const { startRaw, endRaw } = splitTimeRange(row.time);
      const startMin = parseClockMinutes(startRaw);
      const endMin = parseClockMinutes(endRaw);
      if (startMin !== null && (!earliest || startMin < earliest.min)) {
        earliest = { min: startMin, label: startRaw };
      }
      if (endMin !== null && (!latest || endMin > latest.min)) {
        latest = { min: endMin, label: endRaw };
      }
    });
  }
  return { arrival: earliest ? earliest.label : null, departure: latest ? latest.label : null };
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

  let rows = [];
  for (const m of members) {
    const { monday, wednesday, lastUpdated } = await getMemberSchedule(m.id);
    rows.push({ member: m, monday, wednesday, lastUpdated, status: scheduleStatus(monday, wednesday) });
  }

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
async function archiveMemberSchedules(memberIds) {
  let archived = 0;
  const touchedDays = new Set();
  for (const memberId of memberIds) {
    const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!member) continue;
    const { monday, wednesday } = await getMemberSchedule(memberId);

    await db
      .prepare(
        `INSERT INTO member_schedule_archives (member_id, member_name, member_type, monday_schedule, wednesday_schedule)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(member.id, member.name, member.member_type, summarizeScheduleDay(monday), summarizeScheduleDay(wednesday));

    if (monday.some((r) => !rowIsBlank(r))) touchedDays.add('monday');
    if (wednesday.some((r) => !rowIsBlank(r))) touchedDays.add('wednesday');

    if (member.member_type === 'student') {
      const classIds = (await db.prepare('SELECT class_id FROM class_enrollments WHERE student_id = ?').all(memberId)).map((r) => r.class_id);
      await db.prepare('DELETE FROM class_enrollments WHERE student_id = ?').run(memberId);
      for (const classId of classIds) await syncClassRosterMembers(classId);
    } else {
      await db.prepare('DELETE FROM class_staff WHERE member_id = ?').run(memberId);
    }
    archived++;
  }
  for (const day of touchedDays) await syncDayMemberRosters(day);
  return archived;
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
  rowIsBlank,
  scheduleStatus,
  scheduleList,
  arrivalDepartureLabels,
  parseClockMinutes,
  splitTimeRange,
  archiveMemberSchedules,
  listMemberScheduleArchives,
  deleteMemberScheduleArchive,
  deleteAllMemberScheduleArchives,
};

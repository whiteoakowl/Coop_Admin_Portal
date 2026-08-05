const db = require('../db');

const DAYS = ['monday', 'wednesday'];
const CLASS_NUMBERS = [1, 2, 3, 4];
const DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday' };

// Always returns exactly 4 rows (class_number 1-4) for a day, filling any
// missing class number with a blank placeholder row so the UI/print layout
// never has to special-case "fewer than 4 classes".
function fourRows(rows) {
  const byNumber = {};
  rows.forEach((r) => { byNumber[r.class_number] = r; });
  return CLASS_NUMBERS.map((n) => byNumber[n] || { class_number: n, time: '', class_name: '', room: '', teacher: '' });
}

function getMemberSchedule(memberId) {
  const rows = db.prepare('SELECT * FROM member_schedules WHERE member_id = ? ORDER BY day, class_number').all(memberId);
  const monday = fourRows(rows.filter((r) => r.day === 'monday'));
  const wednesday = fourRows(rows.filter((r) => r.day === 'wednesday'));
  const lastUpdated = rows.length ? rows.map((r) => r.updated_at).sort().slice(-1)[0] : null;
  return { monday, wednesday, lastUpdated };
}

function rowIsBlank(row) {
  return !row.time && !row.class_name && !row.room && !row.teacher;
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

// Replaces a member's full schedule (both days) in one transaction-like
// pass. dayRows is { monday: [{time,className,room,teacher} x4], wednesday: [...] }.
// A blank row (all 4 fields empty) is deleted rather than stored, so
// clearing a class removes it instead of leaving an empty row behind.
function saveMemberSchedule(memberId, dayRows) {
  const del = db.prepare('DELETE FROM member_schedules WHERE member_id = ? AND day = ? AND class_number = ?');
  const upsert = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(member_id, day, class_number) DO UPDATE SET
       time = excluded.time, class_name = excluded.class_name, room = excluded.room,
       teacher = excluded.teacher, updated_at = datetime('now')`
  );
  DAYS.forEach((day) => {
    const rows = (dayRows[day] || []).slice(0, 4);
    CLASS_NUMBERS.forEach((n) => {
      const row = rows[n - 1] || {};
      const time = (row.time || '').trim();
      const className = (row.className || '').trim();
      const room = (row.room || '').trim();
      const teacher = (row.teacher || '').trim();
      if (!time && !className && !room && !teacher) {
        del.run(memberId, day, n);
      } else {
        upsert.run(memberId, day, n, time, className, room, teacher);
      }
    });
  });
}

function deleteMemberSchedule(memberId) {
  db.prepare('DELETE FROM member_schedules WHERE member_id = ?').run(memberId);
}

function duplicateMemberSchedule(fromMemberId, toMemberId) {
  const rows = db.prepare('SELECT * FROM member_schedules WHERE member_id = ?').all(fromMemberId);
  deleteMemberSchedule(toMemberId);
  const insert = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  rows.forEach((r) => insert.run(toMemberId, r.day, r.class_number, r.time, r.class_name, r.room, r.teacher));
  return rows.length;
}

// One row per active student, joined with their schedule summary, for the
// Class Schedules table. Filters are all optional/AND-combined.
function scheduleList(filters) {
  filters = filters || {};
  let members = db
    .prepare("SELECT * FROM members WHERE active = 1 AND member_type = 'student' ORDER BY name COLLATE NOCASE")
    .all();

  if (filters.search) {
    const q = filters.search.toLowerCase();
    members = members.filter((m) => m.name.toLowerCase().includes(q));
  }
  if (filters.grade) {
    members = members.filter((m) => (m.grade_level || '') === filters.grade);
  }
  if (filters.rosterId) {
    const memberIds = new Set(
      db.prepare('SELECT member_id FROM roster_members WHERE roster_id = ?').all(filters.rosterId).map((r) => r.member_id)
    );
    members = members.filter((m) => memberIds.has(m.id));
  }
  if (filters.memberId) {
    members = members.filter((m) => m.id === filters.memberId);
  }

  let rows = members.map((m) => {
    const { monday, wednesday, lastUpdated } = getMemberSchedule(m.id);
    return { member: m, monday, wednesday, lastUpdated, status: scheduleStatus(monday, wednesday) };
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

// Distinct, sorted values for filter dropdowns - pulled from actual saved
// schedule data (not a separate managed catalog, since teachers/rooms/
// classes aren't first-class entities in this app's simple schedule model).
function distinctScheduleValues(column) {
  const rows = db
    .prepare(`SELECT DISTINCT ${column} AS v FROM member_schedules WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY ${column} COLLATE NOCASE`)
    .all();
  return rows.map((r) => r.v);
}

function distinctGrades() {
  return db
    .prepare("SELECT DISTINCT grade_level AS v FROM members WHERE active = 1 AND member_type = 'student' AND grade_level IS NOT NULL AND grade_level != '' ORDER BY grade_level COLLATE NOCASE")
    .all()
    .map((r) => r.v);
}

module.exports = {
  DAYS,
  CLASS_NUMBERS,
  DAY_LABELS,
  STATUS_LABELS,
  getMemberSchedule,
  rowIsBlank,
  scheduleStatus,
  saveMemberSchedule,
  deleteMemberSchedule,
  duplicateMemberSchedule,
  scheduleList,
  distinctScheduleValues,
  distinctGrades,
};

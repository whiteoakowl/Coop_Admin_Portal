const db = require('../db');
const { DAYS, DAY_LABELS } = require('./days');

const CLASS_NUMBERS = [1, 2, 3, 4];

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

// A member's earliest class start and latest class end - used to
// auto-fill Arrival/Departure on the roster view instead of requiring an
// admin to type them in by hand. `day` ('monday' or 'wednesday') scopes
// this to the roster's own day, matching Monday rosters to the Monday
// schedule and Wednesday rosters to the Wednesday schedule; omit it (or
// pass anything else) to fall back to both days combined. Returns raw
// label strings (whatever the admin typed for that class's time, not
// reformatted) or null if nothing on the schedule parses.
function arrivalDepartureLabels(memberId, day) {
  const { monday, wednesday } = getMemberSchedule(memberId);
  const rows = day === 'monday' ? monday : day === 'wednesday' ? wednesday : [...monday, ...wednesday];
  let earliest = null;
  let latest = null;
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

// One row per active student, joined with their schedule summary, for the
// Class Schedules table. Filters are all optional/AND-combined.
function scheduleList(filters) {
  filters = filters || {};
  let members = db
    .prepare('SELECT * FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
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

module.exports = {
  DAYS,
  CLASS_NUMBERS,
  DAY_LABELS,
  STATUS_LABELS,
  getMemberSchedule,
  rowIsBlank,
  scheduleStatus,
  saveMemberSchedule,
  scheduleList,
  arrivalDepartureLabels,
};

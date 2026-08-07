const db = require('../db');
const { DAYS, DAY_LABELS, isValidDay, defaultDay } = require('./days');

const HOUR_POSITIONS = [1, 2, 3, 4];

// Cycled through in order as new classes are created, so a freshly built
// schedule is colorful without an admin having to pick a color every time.
const COLOR_PALETTE = ['#EE9A4D', '#5B9BD5', '#70AD47', '#9B6BC7', '#E06666', '#4EB8B0', '#D6A429', '#C77BA6'];

function nextPaletteColor() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM classes').get().c;
  return COLOR_PALETTE[count % COLOR_PALETTE.length];
}

function hoursForDay(day) {
  return db.prepare('SELECT * FROM class_schedule_hours WHERE day = ? ORDER BY position').all(day);
}

function saveHourLabels(day, labels) {
  const upsert = db.prepare(
    `INSERT INTO class_schedule_hours (day, position, label) VALUES (?, ?, ?)
     ON CONFLICT(day, position) DO UPDATE SET label = excluded.label`
  );
  HOUR_POSITIONS.forEach((position) => {
    const label = (labels[position - 1] || `Hour ${position}`).trim() || `Hour ${position}`;
    upsert.run(day, position, label);
  });
}

function studentsForClass(classId) {
  return db
    .prepare(
      `SELECT m.* FROM class_enrollments ce
       JOIN members m ON m.id = ce.student_id
       WHERE ce.class_id = ? AND m.active = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(classId);
}

function staffForClass(classId) {
  return db
    .prepare(
      `SELECT m.*, cs.role FROM class_staff cs
       JOIN members m ON m.id = cs.member_id
       WHERE cs.class_id = ? AND m.active = 1
       ORDER BY cs.role, m.name COLLATE NOCASE`
    )
    .all(classId);
}

// One class, fully hydrated with its enrolled students and staff - used by
// both the manage form and the public signup page.
function getClass(id) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) return null;
  return { ...cls, students: studentsForClass(id), staff: staffForClass(id) };
}

// Every class on a day, grouped under its hour slot - the shape the
// colored grid (admin and public) renders directly.
function gridForDay(day) {
  const hours = hoursForDay(day);
  const classes = db
    .prepare('SELECT * FROM classes WHERE day = ? ORDER BY hour_position, class_name COLLATE NOCASE')
    .all(day);

  const byHour = {};
  for (const h of HOUR_POSITIONS) byHour[h] = [];
  classes.forEach((cls) => {
    byHour[cls.hour_position].push({ ...cls, students: studentsForClass(cls.id), staff: staffForClass(cls.id) });
  });

  return hours.map((h) => ({ ...h, classes: byHour[h.position] || [] }));
}

// The admin grid view: classroom locations as rows, hour blocks as
// columns. Two consecutive classes in the same room sharing a name and
// color are treated as one class that runs across both blocks, and
// rendered as a single cell spanning both columns instead of two
// separate cards.
function roomGridForDay(day) {
  const hours = hoursForDay(day);
  const classes = db
    .prepare('SELECT * FROM classes WHERE day = ? ORDER BY hour_position, class_name COLLATE NOCASE')
    .all(day)
    .map((cls) => ({ ...cls, students: studentsForClass(cls.id), staff: staffForClass(cls.id) }));

  const roomNames = [...new Set(classes.map((c) => (c.room && c.room.trim() ? c.room.trim() : 'Unassigned')))].sort(
    (a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    }
  );

  const rows = roomNames.map((room) => {
    const byHour = {};
    for (const h of HOUR_POSITIONS) byHour[h] = [];
    classes.forEach((cls) => {
      const clsRoom = cls.room && cls.room.trim() ? cls.room.trim() : 'Unassigned';
      if (clsRoom === room) byHour[cls.hour_position].push(cls);
    });

    const cells = [];
    let h = 1;
    while (h <= HOUR_POSITIONS.length) {
      const here = byHour[h];
      const next = byHour[h + 1];
      if (
        here.length === 1 &&
        next &&
        next.length === 1 &&
        next[0].class_name.toLowerCase() === here[0].class_name.toLowerCase() &&
        next[0].color === here[0].color
      ) {
        cells.push({ span: 2, classes: [here[0]] });
        h += 2;
      } else {
        cells.push({ span: 1, classes: here });
        h += 1;
      }
    }
    return { room, cells };
  });

  return { hours, rows };
}

function createClass(fields) {
  const info = db
    .prepare(
      `INSERT INTO classes (day, hour_position, class_name, room, age_group, color, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.day,
      fields.hourPosition,
      fields.className,
      fields.room || null,
      fields.ageGroup || null,
      fields.color || nextPaletteColor(),
      fields.notes || null
    );
  const id = info.lastInsertRowid;
  ensureClassRoster(id);
  return id;
}

function updateClass(id, fields) {
  const before = db.prepare('SELECT roster_id FROM classes WHERE id = ?').get(id);
  db.prepare(
    `UPDATE classes SET day = ?, hour_position = ?, class_name = ?, room = ?, age_group = ?, color = ?, notes = ? WHERE id = ?`
  ).run(
    fields.day,
    fields.hourPosition,
    fields.className,
    fields.room || null,
    fields.ageGroup || null,
    fields.color || '#EE9A4D',
    fields.notes || null,
    id
  );
  // Keep the class's auto-roster's name/day in step with the class itself.
  if (before && before.roster_id) {
    db.prepare('UPDATE rosters SET name = ?, schedule_day = ? WHERE id = ?').run(fields.className, fields.day, before.roster_id);
  }
}

// Deactivates (never hard-deletes) the class's auto-roster before removing
// the class - a hard delete would cascade-wipe its attendance history
// (attendance.roster_id references rosters ON DELETE CASCADE). Deactivating
// just retires it from active use, same as manually archiving any roster.
function deleteClass(id) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) return;
  if (cls.roster_id) {
    db.prepare('UPDATE rosters SET active = 0 WHERE id = ?').run(cls.roster_id);
  }
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  syncDayMemberRosters(cls.day);
}

function setEnrollment(classId, studentIds) {
  db.prepare('DELETE FROM class_enrollments WHERE class_id = ?').run(classId);
  const link = db.prepare('INSERT OR IGNORE INTO class_enrollments (class_id, student_id) VALUES (?, ?)');
  for (const studentId of studentIds) link.run(classId, studentId);
  syncClassRosterMembers(classId);
  const cls = db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) syncDayMemberRosters(cls.day);
}

// Adds one teacher/assistant - used by both the admin manage form (one at
// a time, via the picker) and the public self-signup page.
function addStaff(classId, memberId, role) {
  db.prepare('INSERT OR REPLACE INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)').run(
    classId,
    memberId,
    role === 'assistant' ? 'assistant' : 'teacher'
  );
  const cls = db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) syncDayMemberRosters(cls.day);
}

function removeStaff(classId, memberId) {
  db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(classId, memberId);
  const cls = db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) syncDayMemberRosters(cls.day);
}

// Active students, for the enrollment picker.
function activeStudents() {
  return db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'student' ORDER BY name COLLATE NOCASE").all();
}

// Active parents, for the teacher/assistant picker - same restriction the
// Floater Assignments and Setup/Cleanup pickers already use.
function activeParentsForStaff() {
  return db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY name COLLATE NOCASE").all();
}

// Every class on this day missing a teacher and/or an assistant - drives
// the Floater Assignments page's "needs a teacher or assistant" log.
function classesNeedingStaffForDay(day) {
  const hours = gridForDay(day);
  const result = [];
  hours.forEach((h) => {
    h.classes.forEach((cls) => {
      const hasTeacher = cls.staff.some((s) => s.role === 'teacher');
      const hasAssistant = cls.staff.some((s) => s.role === 'assistant');
      if (!hasTeacher || !hasAssistant) {
        result.push({
          hourLabel: h.label,
          className: cls.class_name,
          room: cls.room,
          missingTeacher: !hasTeacher,
          missingAssistant: !hasAssistant,
        });
      }
    });
  });
  return result;
}

// Every distinct teacher or assistant staffing a class on this day, each
// with the full list of classes they're staffing that day - drives the
// Volunteers page's Teachers/Class Assistants tabs.
function staffListForDay(day, role) {
  const hours = gridForDay(day);
  const byMember = {};
  hours.forEach((h) => {
    h.classes.forEach((cls) => {
      cls.staff
        .filter((s) => s.role === role)
        .forEach((s) => {
          if (!byMember[s.id]) byMember[s.id] = { member: s, classes: [] };
          byMember[s.id].classes.push({ hourLabel: h.label, className: cls.class_name, room: cls.room });
        });
    });
  });
  return Object.values(byMember).sort((a, b) => a.member.name.localeCompare(b.member.name, undefined, { sensitivity: 'base' }));
}

// Every class on this day whose expected attendee count (enrolled minus
// anyone confirmed absent for `date`) is 3 or fewer - flags classes that
// may need to be canceled for low turnout. Counts both students who've
// already checked in and those who haven't checked in yet, only
// excluding students confirmed absent for that date.
function classesAtRiskForDay(day, date) {
  const hours = gridForDay(day);
  const absentIds = date ? absentMemberIdsForDate(date) : new Set();
  const result = [];
  hours.forEach((h) => {
    h.classes.forEach((cls) => {
      if (cls.students.length === 0) return;
      const expectedCount = cls.students.filter((s) => !absentIds.has(s.id)).length;
      if (expectedCount <= 3) {
        result.push({
          hourLabel: h.label,
          className: cls.class_name,
          room: cls.room,
          enrolledCount: cls.students.length,
          expectedCount,
        });
      }
    });
  });
  return result;
}

// Every member marked absent (any roster) on a given date - the Class
// Schedule grid cross-references this against each class's enrolled
// students to highlight who's out that day.
function absentMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    db.prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND status = 'absent'`).all(date).map((r) => r.member_id)
  );
}

// Everyone who submitted an Absence/Late form for a given date (either
// type - a "late" submission means they still won't be at their usual
// spot on time, so the automated sub system shouldn't count on them for a
// floater slot that day either).
function absenceFormMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    db
      .prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND source = 'absence_form' AND status IN ('absent', 'late')`)
      .all(date)
      .map((r) => r.member_id)
  );
}

// --- Rosters auto-created from class registration ------------------------
//
// Every class gets its own students-only roster, and each day gets one
// Parent and one Student roster covering everyone registered that day
// (enrolled in, or staffing, any class on it). Only MEMBERSHIP is kept in
// sync here - each roster keeps its own independently admin-editable
// roster_dates, exactly like a manually-created roster; nothing here ever
// touches roster_dates.

// Adds/removes roster_members rows so a roster's 'auto' membership matches
// memberIdSet exactly, without touching anyone's scheduled_arrival/
// departure or the roster's dates. Rows an admin added by hand (source =
// 'manual', via the Attendance page's Add Member popup) are never touched
// here, so they survive every resync instead of getting silently dropped
// the next time class enrollment/staffing changes.
function setRosterMembership(rosterId, memberIdSet) {
  const existingIds = db
    .prepare("SELECT member_id FROM roster_members WHERE roster_id = ? AND source = 'auto'")
    .all(rosterId)
    .map((r) => r.member_id);
  const existing = new Set(existingIds);
  const insert = db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')");
  const remove = db.prepare("DELETE FROM roster_members WHERE roster_id = ? AND member_id = ? AND source = 'auto'");
  for (const memberId of memberIdSet) {
    if (!existing.has(memberId)) insert.run(rosterId, memberId);
  }
  for (const memberId of existingIds) {
    if (!memberIdSet.has(memberId)) remove.run(rosterId, memberId);
  }
}

// Every class across both days, for the Attendance page's Class Rosters
// tab - each row links to that class's own auto-maintained roster (see
// ensureClassRoster) via its roster_id.
function allClassesList() {
  const rows = db
    .prepare(
      `SELECT c.*, h.label AS hourLabel,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS studentCount
       FROM classes c
       JOIN class_schedule_hours h ON h.day = c.day AND h.position = c.hour_position
       ORDER BY c.day, c.hour_position, c.class_name COLLATE NOCASE`
    )
    .all();
  return rows.map((r) => ({ ...r, dayLabel: DAY_LABELS[r.day] }));
}

// Adds someone to a roster by hand (Attendance page's Add Member popup) -
// tagged source = 'manual' so setRosterMembership's auto-resync never
// removes them again. INSERT OR IGNORE so re-adding an existing auto
// member is a harmless no-op rather than an error.
function addManualRosterMember(rosterId, memberId) {
  db.prepare("INSERT OR IGNORE INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterId, memberId);
}

// Creates (once) the students-only roster for a single class, or returns
// its existing one.
function ensureClassRoster(classId) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return null;
  if (cls.roster_id) {
    const existing = db.prepare('SELECT id FROM rosters WHERE id = ?').get(cls.roster_id);
    if (existing) return existing.id;
  }
  const info = db
    .prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)')
    .run(cls.class_name, 'Class Roster', cls.day);
  db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(info.lastInsertRowid, classId);
  return info.lastInsertRowid;
}

// Rebuilds a class's roster membership from its current enrollment
// (students only - a class roster never includes its teachers/assistants).
function syncClassRosterMembers(classId) {
  const rosterId = ensureClassRoster(classId);
  if (!rosterId) return;
  const studentIds = new Set(
    db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(classId).map((r) => r.student_id)
  );
  setRosterMembership(rosterId, studentIds);
}

const DAY_ROSTER_LABEL = { monday: 'Monday', wednesday: 'Wednesday' };

function dayRosterSettingKey(day, role) {
  return `${day}_${role}_roster_id`;
}

// Creates (once) one of the 4 day-level rosters (Monday/Wednesday x
// Parent/Student), remembering its id via app_settings, or returns the
// existing one.
function ensureDayRoster(day, role) {
  const key = dayRosterSettingKey(day, role);
  const existingId = appSetting(key, null);
  if (existingId) {
    const existing = db.prepare('SELECT id FROM rosters WHERE id = ?').get(existingId);
    if (existing) return existing.id;
  }
  const name = `${DAY_ROSTER_LABEL[day]} ${role === 'parent' ? 'Parents' : 'Students'}`;
  const info = db
    .prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)')
    .run(name, 'Class Schedule', day);
  setAppSetting(key, String(info.lastInsertRowid));
  return info.lastInsertRowid;
}

// Ensures all 4 day-level rosters exist and returns their ids.
function ensureDayMemberRosters() {
  const ids = {};
  DAYS.forEach((day) => {
    ids[day] = { parent: ensureDayRoster(day, 'parent'), student: ensureDayRoster(day, 'student') };
  });
  return ids;
}

// Rebuilds a day's Parent and Student roster membership from everyone
// enrolled in (students) or staffing (parents) any class on that day.
function syncDayMemberRosters(day) {
  const classIds = db.prepare('SELECT id FROM classes WHERE day = ?').all(day).map((r) => r.id);
  const studentIds = new Set();
  const parentIds = new Set();
  if (classIds.length > 0) {
    const placeholders = classIds.map(() => '?').join(',');
    db.prepare(`SELECT DISTINCT student_id FROM class_enrollments WHERE class_id IN (${placeholders})`)
      .all(...classIds)
      .forEach((r) => studentIds.add(r.student_id));
    db.prepare(`SELECT DISTINCT member_id FROM class_staff WHERE class_id IN (${placeholders})`)
      .all(...classIds)
      .forEach((r) => parentIds.add(r.member_id));
  }
  setRosterMembership(ensureDayRoster(day, 'student'), studentIds);
  setRosterMembership(ensureDayRoster(day, 'parent'), parentIds);
}

function appSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setAppSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

module.exports = {
  DAYS,
  DAY_LABELS,
  isValidDay,
  defaultDay,
  HOUR_POSITIONS,
  COLOR_PALETTE,
  hoursForDay,
  saveHourLabels,
  gridForDay,
  roomGridForDay,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  setEnrollment,
  addStaff,
  removeStaff,
  activeStudents,
  activeParentsForStaff,
  staffListForDay,
  classesNeedingStaffForDay,
  classesAtRiskForDay,
  absentMemberIdsForDate,
  absenceFormMemberIdsForDate,
  appSetting,
  setAppSetting,
  ensureClassRoster,
  syncClassRosterMembers,
  ensureDayRoster,
  ensureDayMemberRosters,
  syncDayMemberRosters,
  addManualRosterMember,
  allClassesList,
};

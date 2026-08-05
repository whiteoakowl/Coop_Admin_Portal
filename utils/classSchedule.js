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
  return info.lastInsertRowid;
}

function updateClass(id, fields) {
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
}

function deleteClass(id) {
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
}

function setEnrollment(classId, studentIds) {
  db.prepare('DELETE FROM class_enrollments WHERE class_id = ?').run(classId);
  const link = db.prepare('INSERT OR IGNORE INTO class_enrollments (class_id, student_id) VALUES (?, ?)');
  for (const studentId of studentIds) link.run(classId, studentId);
}

// Adds one teacher/assistant - used by both the admin manage form (one at
// a time, via the picker) and the public self-signup page.
function addStaff(classId, memberId, role) {
  db.prepare('INSERT OR REPLACE INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)').run(
    classId,
    memberId,
    role === 'assistant' ? 'assistant' : 'teacher'
  );
}

function removeStaff(classId, memberId) {
  db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(classId, memberId);
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

// Every member marked absent (any roster) on a given date - the Class
// Schedule grid cross-references this against each class's enrolled
// students to highlight who's out that day.
function absentMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    db.prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND status = 'absent'`).all(date).map((r) => r.member_id)
  );
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
  absentMemberIdsForDate,
  appSetting,
  setAppSetting,
};

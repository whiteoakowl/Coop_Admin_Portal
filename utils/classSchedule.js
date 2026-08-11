const db = require('../db');
const { DAYS, DAY_LABELS, isValidDay, defaultDay } = require('./days');
const { getListByDay, sectionsForList, membersForList } = require('./volunteers');

const HOUR_POSITIONS = [1, 2, 3, 4];

// Every grade a class's Age Group can be checked for (create/edit class
// form) - classes.age_group stores whichever of these are checked as a
// comma-joined string (e.g. "Infant, Toddler"), same pattern as any other
// multi-select-into-one-TEXT-column field in this app.
const GRADE_LEVELS = [
  'Infant',
  'Toddler',
  'Preschool',
  'PreK',
  'Kindergarten',
  '1st',
  '2nd',
  '3rd',
  '4th',
  '5th',
  '6th',
  '7th',
  '8th',
  '9th',
  '10th',
  '11th',
  '12th',
];

function ageGroupList(ageGroup) {
  return (ageGroup || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

// "1st" -> "1", "3rd" -> "3" - the non-numeric grade labels (Infant,
// Toddler, Preschool, PreK, Kindergarten) have no suffix to strip and
// pass through unchanged.
function stripOrdinal(label) {
  return label.replace(/(st|nd|rd|th)$/i, '');
}

// A class card shows its grade(s) as a single compact line - "Grade 1"
// for one grade, "Grades 1-3" for a contiguous run, or a plain comma list
// for a non-contiguous selection (e.g. "1st" and "5th" but nothing
// between) - instead of a badge per grade.
function formatGradeRange(ageGroup) {
  const labels = ageGroupList(ageGroup);
  if (labels.length === 0) return '';
  const indices = labels.map((l) => GRADE_LEVELS.indexOf(l)).filter((i) => i !== -1).sort((a, b) => a - b);
  if (indices.length === 0) return labels.join(', ');
  if (indices.length === 1) return `Grade ${stripOrdinal(GRADE_LEVELS[indices[0]])}`;
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (isContiguous) return `Grades ${stripOrdinal(GRADE_LEVELS[indices[0]])}-${stripOrdinal(GRADE_LEVELS[indices[indices.length - 1]])}`;
  return `Grades ${indices.map((i) => stripOrdinal(GRADE_LEVELS[i])).join(', ')}`;
}

// Cycled through in order as new classes are created, so a freshly built
// schedule is colorful without an admin having to pick a color every time.
// 12 pastel tones spanning the hue wheel, deep/saturated enough to stand
// out on the grid at a glance (not the washed-out, barely-there pastels
// this palette started as) while still reading as "pastel", not neon.
const COLOR_PALETTE = [
  '#F5B67D', // peach
  '#F0DB6E', // yellow
  '#B8DE7A', // lime
  '#86D1A3', // mint
  '#7BD2C6', // teal
  '#7CBBF0', // sky blue
  '#93A4F0', // periwinkle
  '#B79BEA', // lavender
  '#DE93E0', // orchid
  '#F291BE', // pink
  '#F29A8E', // coral
  '#CBAE8B', // sand
];

async function nextPaletteColor() {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM classes').get();
  return COLOR_PALETTE[row.c % COLOR_PALETTE.length];
}

async function hoursForDay(day) {
  return db.prepare('SELECT * FROM class_schedule_hours WHERE day = ? ORDER BY position').all(day);
}

async function saveHourLabels(day, labels) {
  const upsert = db.prepare(
    `INSERT INTO class_schedule_hours (day, position, label) VALUES (?, ?, ?)
     ON CONFLICT(day, position) DO UPDATE SET label = excluded.label`
  );
  for (const position of HOUR_POSITIONS) {
    const label = (labels[position - 1] || `Hour ${position}`).trim() || `Hour ${position}`;
    await upsert.run(day, position, label);
  }
}

// A single hour's label, for callers editing just one card at a time (the
// Floater Teams page - each card is one hour) - saveHourLabels above
// always rewrites every HOUR_POSITIONS entry for the day (it's built for
// the Class Schedule page's one "Edit" dialog that shows all of them at
// once), so reusing it for a single card would silently reset every other
// hour's label back to its "Hour N" default.
async function saveHourLabel(day, position, label) {
  const trimmed = (label || '').trim() || `Hour ${position}`;
  await db.prepare(
    `INSERT INTO class_schedule_hours (day, position, label) VALUES (?, ?, ?)
     ON CONFLICT(day, position) DO UPDATE SET label = excluded.label`
  ).run(day, position, trimmed);
}

async function studentsForClass(classId) {
  return db
    .prepare(
      `SELECT m.*, f.name AS family_name FROM class_enrollments ce
       JOIN members m ON m.id = ce.student_id
       LEFT JOIN families f ON f.id = m.family_id
       WHERE ce.class_id = ? AND m.active = 1
       ORDER BY LOWER(m.name)`
    )
    .all(classId);
}

async function staffForClass(classId) {
  return db
    .prepare(
      `SELECT m.*, cs.role FROM class_staff cs
       JOIN members m ON m.id = cs.member_id
       WHERE cs.class_id = ? AND m.active = 1
       ORDER BY cs.role, LOWER(m.name)`
    )
    .all(classId);
}

// One class, fully hydrated with its enrolled students and staff - used by
// both the manage form and the public signup page.
async function getClass(id) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) return null;
  return { ...cls, students: await studentsForClass(id), staff: await staffForClass(id) };
}

// Every class on a day, grouped under its hour slot - the shape the
// colored grid (admin and public) renders directly.
async function gridForDay(day) {
  const hours = await hoursForDay(day);
  const classes = await db
    .prepare('SELECT * FROM classes WHERE day = ? ORDER BY hour_position, LOWER(class_name)')
    .all(day);

  const byHour = {};
  for (const h of HOUR_POSITIONS) byHour[h] = [];
  for (const cls of classes) {
    byHour[cls.hour_position].push({ ...cls, students: await studentsForClass(cls.id), staff: await staffForClass(cls.id) });
  }

  return hours.map((h) => ({ ...h, classes: byHour[h.position] || [] }));
}

// The admin grid view: classroom locations as rows, hour blocks as
// columns. Two consecutive classes in the same room sharing a name and
// color are treated as one class that runs across both blocks, and
// rendered as a single cell spanning both columns instead of two
// separate cards.
async function roomGridForDay(day) {
  const hours = await hoursForDay(day);
  const rawClasses = await db
    .prepare('SELECT * FROM classes WHERE day = ? ORDER BY hour_position, LOWER(class_name)')
    .all(day);
  const classes = [];
  for (const cls of rawClasses) {
    const staff = await staffForClass(cls.id);
    classes.push({
      ...cls,
      students: await studentsForClass(cls.id),
      staff,
      gradeLabel: formatGradeRange(cls.age_group),
      teacherNames: staff.filter((s) => s.role === 'teacher').map((s) => s.name),
      assistantNames: staff.filter((s) => s.role === 'assistant').map((s) => s.name),
    });
  }

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

// Every distinct room name in use on a day - rooms aren't their own
// managed entity (just whatever string is typed into each class's room
// field), so "Edit Room Numbers" works off whatever's actually in use,
// same idea as Edit Hours but derived instead of a fixed table.
async function roomsForDay(day) {
  return (
    await db
      .prepare("SELECT DISTINCT room FROM classes WHERE day = ? AND room IS NOT NULL AND room != '' ORDER BY LOWER(room)")
      .all(day)
  ).map((r) => r.room);
}

// Renames a room across every class on a day that currently uses it - the
// bulk-edit half of "Edit Room Numbers".
async function renameRoom(day, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  await db.prepare('UPDATE classes SET room = ? WHERE day = ? AND room = ?').run(newName, day, oldName);
}

async function createClass(fields) {
  const info = await db
    .prepare(
      `INSERT INTO classes (day, hour_position, class_name, room, age_group, color, notes, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.day,
      fields.hourPosition,
      fields.className,
      fields.room || null,
      fields.ageGroup || null,
      fields.color || (await nextPaletteColor()),
      fields.notes || null,
      fields.startTime || null,
      fields.endTime || null
    );
  const id = info.lastInsertRowid;
  await ensureClassRoster(id);
  return id;
}

async function updateClass(id, fields) {
  const before = await db.prepare('SELECT roster_id, day FROM classes WHERE id = ?').get(id);
  await db.prepare(
    `UPDATE classes SET day = ?, hour_position = ?, class_name = ?, room = ?, age_group = ?, color = ?, notes = ?, start_time = ?, end_time = ? WHERE id = ?`
  ).run(
    fields.day,
    fields.hourPosition,
    fields.className,
    fields.room || null,
    fields.ageGroup || null,
    fields.color || '#EE9A4D',
    fields.notes || null,
    fields.startTime || null,
    fields.endTime || null,
    id
  );
  // Keep the class's auto-roster's name/day in step with the class itself.
  if (before && before.roster_id) {
    await db.prepare('UPDATE rosters SET name = ?, schedule_day = ? WHERE id = ?').run(fields.className, fields.day, before.roster_id);
  }
  // Re-derive roster membership + member_schedules for whichever day(s)
  // are affected - both the old day (in case this class just moved off
  // it) and the new one.
  await syncDayMemberRosters(fields.day);
  if (before && before.day && before.day !== fields.day) await syncDayMemberRosters(before.day);
}

// Deactivates (never hard-deletes) the class's auto-roster before removing
// the class - a hard delete would cascade-wipe its attendance history
// (attendance.roster_id references rosters ON DELETE CASCADE). Deactivating
// just retires it from active use, same as manually archiving any roster.
async function deleteClass(id) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!cls) return;
  await db.withTransaction(async (tx) => {
    if (cls.roster_id) {
      await tx.prepare('UPDATE rosters SET active = 0 WHERE id = ?').run(cls.roster_id);
    }
    await tx.prepare('DELETE FROM classes WHERE id = ?').run(id);
  });
  await syncDayMemberRosters(cls.day);
}

async function setEnrollment(classId, studentIds) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM class_enrollments WHERE class_id = ?').run(classId);
    const link = tx.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?) ON CONFLICT (class_id, student_id) DO NOTHING');
    for (const studentId of studentIds) await link.run(classId, studentId);
  });
  await syncClassRosterMembers(classId);
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

// Adds one teacher/assistant - used by both the admin manage form (one at
// a time, via the picker) and the public self-signup page.
async function addStaff(classId, memberId, role) {
  await db
    .prepare(
      `INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)
       ON CONFLICT (class_id, member_id) DO UPDATE SET role = excluded.role`
    )
    .run(classId, memberId, role === 'assistant' ? 'assistant' : 'teacher');
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

async function removeStaff(classId, memberId) {
  await db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(classId, memberId);
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

// Active students, for the enrollment picker.
async function activeStudents() {
  return db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'student' ORDER BY LOWER(name)").all();
}

// Active parents, for the teacher/assistant picker - same restriction the
// Floater Assignments and Setup/Cleanup pickers already use.
async function activeParentsForStaff() {
  return db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'parent' ORDER BY LOWER(name)").all();
}

// Every class on this day missing a teacher and/or an assistant - drives
// the Floater Assignments page's "needs a teacher or assistant" log.
async function classesNeedingStaffForDay(day) {
  const hours = await gridForDay(day);
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
async function staffListForDay(day, role) {
  const hours = await gridForDay(day);
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
async function classesAtRiskForDay(day, date) {
  const hours = await gridForDay(day);
  const absentIds = date ? await absentMemberIdsForDate(date) : new Set();
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
async function absentMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    (await db.prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND status = 'absent'`).all(date)).map(
      (r) => r.member_id
    )
  );
}

// Everyone who submitted an Absence/Late form for a given date (either
// type - a "late" submission means they still won't be at their usual
// spot on time, so the automated sub system shouldn't count on them for a
// floater slot that day either).
async function absenceFormMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    (
      await db
        .prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND source = 'absence_form' AND status IN ('absent', 'late')`)
        .all(date)
    ).map((r) => r.member_id)
  );
}

// Everyone marked absent OR late for a given date, any source (checked in
// that way on a roster, or via an Absence/Late form) - the single "won't
// be where they're expected today" signal the floater-assignment board
// uses, both to keep someone out of the substitute pool and to decide
// whether a class needs a floater covering for one of its own teachers or
// assistants. Maps member id -> whichever status was recorded ('absent'
// wins if a member somehow has mixed statuses across rosters for the same
// date).
async function missingMemberIdsForDate(date) {
  if (!date) return new Map();
  const rows = await db
    .prepare(`SELECT member_id, status FROM attendance WHERE session_date = ? AND status IN ('absent', 'late')`)
    .all(date);
  const map = new Map();
  rows.forEach((r) => {
    if (r.status === 'absent' || !map.has(r.member_id)) map.set(r.member_id, r.status);
  });
  return map;
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
async function setRosterMembership(rosterId, memberIdSet) {
  const existingIds = (
    await db.prepare("SELECT member_id FROM roster_members WHERE roster_id = ? AND source = 'auto'").all(rosterId)
  ).map((r) => r.member_id);
  const existing = new Set(existingIds);
  const insert = db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')");
  const remove = db.prepare("DELETE FROM roster_members WHERE roster_id = ? AND member_id = ? AND source = 'auto'");
  for (const memberId of memberIdSet) {
    if (!existing.has(memberId)) await insert.run(rosterId, memberId);
  }
  for (const memberId of existingIds) {
    if (!memberIdSet.has(memberId)) await remove.run(rosterId, memberId);
  }
}

// Every class across both days, for the Attendance page's Class Rosters
// tab - each row links to that class's own auto-maintained roster (see
// ensureClassRoster) via its roster_id.
// The Attendance page's Class Rosters log list - every class (optionally
// filtered to one day), alphabetical by title, each with the grade(s)/
// day/time/teacher/assistants needed for that one-line summary.
async function allClassesList(day) {
  const rows = await db
    .prepare(
      `SELECT c.*, h.label AS hourLabel,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS studentCount
       FROM classes c
       JOIN class_schedule_hours h ON h.day = c.day AND h.position = c.hour_position
       WHERE (@day IS NULL OR c.day = @day)
       ORDER BY LOWER(c.class_name)`
    )
    .all({ day: day || null });
  const list = [];
  for (const r of rows) {
    const staff = await staffForClass(r.id);
    list.push({
      ...r,
      dayLabel: DAY_LABELS[r.day],
      gradeLabel: formatGradeRange(r.age_group),
      timeLabel: await timeRangeForClass(r),
      teacherNames: staff.filter((s) => s.role === 'teacher').map((s) => s.name),
      assistantNames: staff.filter((s) => s.role === 'assistant').map((s) => s.name),
    });
  }
  return list;
}

// Adds someone to a roster by hand (Attendance page's Add Member popup) -
// tagged source = 'manual' so setRosterMembership's auto-resync never
// removes them again. INSERT ... ON CONFLICT DO NOTHING so re-adding an
// existing auto member is a harmless no-op rather than an error.
async function addManualRosterMember(rosterId, memberId) {
  await db
    .prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING")
    .run(rosterId, memberId);
}

// Creates (once) the students-only roster for a single class, or returns
// its existing one.
async function ensureClassRoster(classId) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return null;
  if (cls.roster_id) {
    const existing = await db.prepare('SELECT id FROM rosters WHERE id = ?').get(cls.roster_id);
    if (existing) return existing.id;
  }
  const info = await db
    .prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)')
    .run(cls.class_name, 'Class Roster', cls.day);
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(info.lastInsertRowid, classId);
  return info.lastInsertRowid;
}

// Rebuilds a class's roster membership from its current enrollment
// (students only - a class roster never includes its teachers/assistants).
async function syncClassRosterMembers(classId) {
  const rosterId = await ensureClassRoster(classId);
  if (!rosterId) return;
  const studentIds = new Set(
    (await db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(classId)).map((r) => r.student_id)
  );
  await setRosterMembership(rosterId, studentIds);
}

const DAY_ROSTER_LABEL = { monday: 'Monday', wednesday: 'Wednesday' };

function dayRosterSettingKey(day, role) {
  return `${day}_${role}_roster_id`;
}

// Creates (once) one of the 4 day-level rosters (Monday/Wednesday x
// Parent/Student), remembering its id via app_settings, or returns the
// existing one.
async function ensureDayRoster(day, role) {
  const key = dayRosterSettingKey(day, role);
  const existingId = await appSetting(key, null);
  if (existingId) {
    const existing = await db.prepare('SELECT id FROM rosters WHERE id = ?').get(existingId);
    if (existing) return existing.id;
  }
  const name = `${DAY_ROSTER_LABEL[day]} ${role === 'parent' ? 'Parents' : 'Students'}`;
  const info = await db
    .prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)')
    .run(name, 'Class Schedule', day);
  await setAppSetting(key, String(info.lastInsertRowid));
  return info.lastInsertRowid;
}

// Ensures all 4 day-level rosters exist and returns their ids.
async function ensureDayMemberRosters() {
  const ids = {};
  for (const day of DAYS) {
    ids[day] = { parent: await ensureDayRoster(day, 'parent'), student: await ensureDayRoster(day, 'student') };
  }
  return ids;
}

// Everyone floating any hour on a day's Floater Assignments list - a
// parent only needs to be assigned to ONE hour to count as floating that
// day, same "day-level" granularity as teaching/assisting a class.
async function floaterMemberIdsForDay(day) {
  const list = await getListByDay(day);
  if (!list) return [];
  return (await membersForList(list.id)).map((m) => m.id);
}

// Rebuilds a day's Parent and Student roster membership from everyone
// enrolled in (students) or staffing/floating (parents) that day - a
// class's teacher/assistants, or anyone on the Floater Assignments list
// for any hour that day.
async function syncDayMemberRosters(day) {
  const classIds = (await db.prepare('SELECT id FROM classes WHERE day = ?').all(day)).map((r) => r.id);
  const studentIds = new Set();
  const parentIds = new Set();
  if (classIds.length > 0) {
    const placeholders = classIds.map(() => '?').join(',');
    (await db.prepare(`SELECT DISTINCT student_id FROM class_enrollments WHERE class_id IN (${placeholders})`).all(...classIds)).forEach(
      (r) => studentIds.add(r.student_id)
    );
    (await db.prepare(`SELECT DISTINCT member_id FROM class_staff WHERE class_id IN (${placeholders})`).all(...classIds)).forEach((r) =>
      parentIds.add(r.member_id)
    );
  }
  (await floaterMemberIdsForDay(day)).forEach((id) => parentIds.add(id));
  await setRosterMembership(await ensureDayRoster(day, 'student'), studentIds);
  await setRosterMembership(await ensureDayRoster(day, 'parent'), parentIds);
  await syncMemberSchedulesForDay(day);
}

// A class's display time range: its own start_time/end_time if an admin
// set them, otherwise its hour block's shared label (e.g. "Hour 1" or
// whatever an admin renamed it to via Edit Hours).
async function timeRangeForClass(cls) {
  if (cls.start_time && cls.end_time) return `${cls.start_time} - ${cls.end_time}`;
  const hour = await db.prepare('SELECT label FROM class_schedule_hours WHERE day = ? AND position = ?').get(cls.day, cls.hour_position);
  return (hour && hour.label) || '';
}

// member_schedules (the per-member "Schedule Card" / profile Class
// Schedule tab data) is entirely derived from the master Class Schedule
// and the Floater Assignments list - there's no separate hand-typed
// version anymore, so this fully rebuilds one day's rows every time
// either changes (called from syncDayMemberRosters, which already runs
// on every enrollment/staff/class/floater edit). A person shows up once
// per class they're either enrolled in (student) or staffing (teacher/
// assistant); "teacher" on their row lists that class's teacher(s),
// themselves included if that's their own class. A floater then fills in
// any of THEIR hours that aren't already a real class slot on their own
// schedule, labeled "Floater" - matched purely by hour position (the
// Floater Assignments chart's "Hour N" against the class grid's own
// "Hour N", the same position class_schedule_hours already keys both by),
// not to any specific class, so it never overwrites a real one.
//
// datetime('now') - SQLite-only, deliberately left as-is (see
// MIGRATION.md's special-cases list); not touched by this routine
// async/await pass.
async function syncMemberSchedulesForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  await db.prepare('DELETE FROM member_schedules WHERE day = ?').run(day);
  const upsert = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(member_id, day, class_number) DO UPDATE SET
       time = excluded.time, class_name = excluded.class_name, room = excluded.room,
       teacher = excluded.teacher, updated_at = datetime('now')`
  );

  for (const cls of classes) {
    const time = await timeRangeForClass(cls);
    const staff = await staffForClass(cls.id);
    const teacherNames = staff.filter((s) => s.role === 'teacher').map((s) => s.name).join(', ');
    const people = [...(await studentsForClass(cls.id)), ...staff];
    for (const person of people) {
      await upsert.run(person.id, day, cls.hour_position, time, cls.class_name, cls.room || '', teacherNames);
    }
  }

  const insertIfEmpty = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, 'Floater', '', '', datetime('now'))
     ON CONFLICT(member_id, day, class_number) DO NOTHING`
  );
  const list = await getListByDay(day);
  if (list) {
    const hourLabels = {};
    (await hoursForDay(day)).forEach((h) => { hourLabels[h.position] = h.label; });
    for (const section of await sectionsForList(list.id)) {
      for (const memberId of await membersForSectionRaw(list.id, section.id)) {
        await insertIfEmpty.run(memberId, day, section.position, hourLabels[section.position] || '');
      }
    }
  }
}

// Bare member ids on one floater hour section - a lightweight variant of
// utils/volunteers.js's membersForSection (which joins in rank/other
// display fields this sync doesn't need).
async function membersForSectionRaw(listId, sectionId) {
  return (
    await db
      .prepare(
        `SELECT m.id FROM members m
         JOIN volunteer_members vm ON vm.member_id = m.id
         WHERE vm.volunteer_list_id = ? AND vm.section_id = ? AND m.active = 1`
      )
      .all(listId, sectionId)
  ).map((r) => r.id);
}

async function appSetting(key, fallback) {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

async function setAppSetting(key, value) {
  await db.prepare(
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
  GRADE_LEVELS,
  ageGroupList,
  formatGradeRange,
  hoursForDay,
  saveHourLabels,
  saveHourLabel,
  gridForDay,
  roomGridForDay,
  roomsForDay,
  renameRoom,
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
  missingMemberIdsForDate,
  appSetting,
  setAppSetting,
  ensureClassRoster,
  syncClassRosterMembers,
  ensureDayRoster,
  ensureDayMemberRosters,
  syncDayMemberRosters,
  syncMemberSchedulesForDay,
  addManualRosterMember,
  allClassesList,
};

const db = require('../db');
const { DAYS, DAY_LABELS, isValidDay, defaultDay } = require('./days');
const { getListByDay, sectionsForList, membersForList, removeMemberFromSection, addMemberToSection } = require('./volunteers');

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

// A class spanning two (or more) consecutive hour blocks is represented
// as one separate `classes` row per block - roomGridForDay only visually
// merges same-room adjacent rows into one colspan cell when they also
// share the same class_name, color, AND grade (see its own comment).
// Creating each block through the picker naturally reuses whatever color
// the admin already has selected, but the Class Schedule Import (one file
// row per block, colorless) would otherwise give each block its own
// independently-cycled nextPaletteColor() and the blocks would never
// visually merge. This looks up whichever color a same-day/room/name/
// grade class already has (from earlier in this same import, or an
// earlier one) and reuses it, only calling nextPaletteColor() the first
// time that combination is seen. Grade is part of the match for the same
// reason it's part of roomGridForDay's own merge condition - a recurring
// class name split across grade bands (e.g. "Forest Wildlings" for K-2 at
// 10am and again for 3-5 at 10:45, same room) is two unrelated classes
// that happen to share a name and land in adjacent slots, not one
// continuing class, and must not end up visually identical either.
async function colorForClassName(day, room, className, ageGroup) {
  const existing = await db
    .prepare(
      `SELECT color FROM classes
       WHERE day = ? AND LOWER(COALESCE(room, '')) = LOWER(?) AND LOWER(class_name) = LOWER(?) AND COALESCE(age_group, '') = COALESCE(?, '')
       LIMIT 1`
    )
    .get(day, room || '', className, ageGroup || null);
  return existing ? existing.color : nextPaletteColor();
}

async function hoursForDay(day) {
  return db.prepare('SELECT * FROM class_schedule_hours WHERE day = ? ORDER BY position').all(day);
}

// startTimes/endTimes are optional, same shape as labels (indexed by
// position - 1) - the hour's own shared Start/End Time (see
// derivedHourTimeRanges's own comment on how this feeds arrival/
// departure and each class's displayed time), set once here instead of
// requiring an admin to open every individual class's own Manage page.
async function saveHourLabels(day, labels, startTimes = [], endTimes = []) {
  const upsert = db.prepare(
    `INSERT INTO class_schedule_hours (day, position, label, start_time, end_time) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, position) DO UPDATE SET label = excluded.label, start_time = excluded.start_time, end_time = excluded.end_time`
  );
  for (const position of HOUR_POSITIONS) {
    const label = (labels[position - 1] || `Hour ${position}`).trim() || `Hour ${position}`;
    const startTime = (startTimes[position - 1] || '').trim() || null;
    const endTime = (endTimes[position - 1] || '').trim() || null;
    await upsert.run(day, position, label, startTime, endTime);
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
// "10:45 AM" -> minutes since midnight, null if unparseable. A local copy
// (also exists in utils/schedule.js and routes/admin-class-schedule.js) -
// requiring utils/schedule.js from here would be circular (it already
// requires this file for syncClassRosterMembers/syncDayMemberRosters).
function parseClockMinutesLocal(raw) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(String(raw || ''));
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const suffix = m[3] ? m[3].toLowerCase() : null;
  if (suffix === 'pm' && hour !== 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

// The reverse of parseClockMinutesLocal - minutes-since-midnight back to
// "10:45 AM".
function minutesToClockLabelLocal(minutes) {
  let hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`;
}

const UNASSIGNED_ROOM = 'Unassigned';

function roomOrderSettingKey(day) {
  return `${day}_room_order`;
}

// A saved custom room order for a day (drag-reordering the grid's rows),
// or [] if the admin has never reordered anything - see roomGridForDay for
// how it's applied. Stored as a JSON array of room names in app_settings,
// same "no dedicated table" approach ensureDayRoster uses for its own
// per-day settings.
async function getRoomOrder(day) {
  const raw = await appSetting(roomOrderSettingKey(day), null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

async function saveRoomOrder(day, rooms) {
  await setAppSetting(roomOrderSettingKey(day), JSON.stringify(rooms));
}

async function roomGridForDay(day) {
  const storedHours = await hoursForDay(day);
  const rawClasses = await db
    .prepare('SELECT * FROM classes WHERE day = ? ORDER BY hour_position, LOWER(class_name)')
    .all(day);

  // Each position's real effective start time, derived from whichever
  // currently-live classes actually occupy it (earliest, if more than
  // one) - not the separately-stored, easily-stale class_schedule_hours
  // label. A real bug report: that stored label only gets refreshed at
  // import time (Class Schedule Import's own sync, for whichever position
  // that one file's rows landed on), so a second, independent import or a
  // manually Added Class touching the same position with a different real
  // time left the header showing the wrong time for whatever was actually
  // there - "classes not lining up with the right time column". Computing
  // it fresh from live data on every render instead means it can't go
  // stale, and self-corrects on deploy with no need to re-import or patch
  // existing data.
  const earliestMinutesByPosition = {};
  rawClasses.forEach((cls) => {
    const minutes = parseClockMinutesLocal(cls.start_time);
    if (minutes == null) return;
    if (earliestMinutesByPosition[cls.hour_position] == null || minutes < earliestMinutesByPosition[cls.hour_position]) {
      earliestMinutesByPosition[cls.hour_position] = minutes;
    }
  });
  const hours = storedHours.map((h) => {
    const minutes = earliestMinutesByPosition[h.position];
    return minutes != null ? { ...h, label: minutesToClockLabelLocal(minutes) } : h;
  });

  // How many of the day's fixed hour columns this one class spans,
  // starting at its own hour_position, based on its own end_time crossing
  // into a later column's real start time (earliestMinutesByPosition
  // above) - e.g. a class stored at hour 1 with end_time 10:40, where
  // hour 2 actually starts at 10:00, spans into hour 2's column without
  // needing a second database row for that block. Returns 1 (no span)
  // when there's no parseable end_time or nothing to compare it against,
  // so the room-grid loop below falls back to the older name/color/grade
  // adjacent-row merge for classes that were never given one.
  function spanFromEndTime(cls) {
    const endMinutes = parseClockMinutesLocal(cls.end_time);
    if (endMinutes == null) return 1;
    let span = 1;
    let p = cls.hour_position + 1;
    while (p <= HOUR_POSITIONS.length && earliestMinutesByPosition[p] != null && endMinutes > earliestMinutesByPosition[p]) {
      span++;
      p++;
    }
    return span;
  }

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
      endTimeSpan: spanFromEndTime(cls),
    });
  }

  const discoveredRoomNames = [...new Set(classes.map((c) => (c.room && c.room.trim() ? c.room.trim() : UNASSIGNED_ROOM)))];
  const savedOrder = await getRoomOrder(day);
  // Whatever's saved comes first, in that order (skipping any room no
  // longer in use); anything new/unordered is appended alphabetically -
  // the same fallback order this grid always used before drag-reordering
  // existed, so a day nobody's ever reordered looks exactly as before.
  const ordered = savedOrder.filter((r) => discoveredRoomNames.includes(r));
  const remaining = discoveredRoomNames
    .filter((r) => !ordered.includes(r))
    .sort((a, b) => {
      if (a === UNASSIGNED_ROOM) return 1;
      if (b === UNASSIGNED_ROOM) return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
  const roomNames = [...ordered, ...remaining];

  const rows = roomNames.map((room) => {
    const byHour = {};
    for (const h of HOUR_POSITIONS) byHour[h] = [];
    classes.forEach((cls) => {
      const clsRoom = cls.room && cls.room.trim() ? cls.room.trim() : UNASSIGNED_ROOM;
      if (clsRoom === room) byHour[cls.hour_position].push(cls);
    });

    const cells = [];
    let h = 1;
    while (h <= HOUR_POSITIONS.length) {
      const here = byHour[h];

      // Preferred over the name/color/grade merge below when the class
      // has its own real end_time crossing into a later column - reflects
      // what the class actually says about itself, not an inference from
      // a second matching row.
      if (here.length === 1 && here[0].endTimeSpan > 1) {
        const span = Math.min(here[0].endTimeSpan, HOUR_POSITIONS.length - h + 1);
        cells.push({ span, classes: [here[0]] });
        h += span;
        continue;
      }

      const next = byHour[h + 1];
      // age_group (grade) is part of this match, not just name/color - a
      // real bug report: a recurring class name split across grade bands
      // (e.g. "Forest Wildlings" for K-2 at 10am and again for 3-5 at
      // 10:45, same room) is two unrelated classes that happen to share a
      // name and land in adjacent slots, not one class continuing for two
      // hours - merging them into one spanned cell silently dropped the
      // second one's own grade/teacher/roster from the grid entirely
      // (only `here[0]` is kept below), which read as that row having
      // been "ignored" by import even though it was created correctly.
      if (
        here.length === 1 &&
        next &&
        next.length === 1 &&
        next[0].class_name.toLowerCase() === here[0].class_name.toLowerCase() &&
        next[0].color === here[0].color &&
        (next[0].age_group || '') === (here[0].age_group || '')
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

// Every distinct room name in use on a day, plus the synthetic
// "Unassigned" bucket roomGridForDay falls classes with a blank room back
// to - real bug report: a class that never got a room set (e.g. a column
// mismatch during import) showed up under "Unassigned" on the grid with
// no way to fix it, since this list (what "Edit Room Numbers" and the Add
// Class room datalist both offer) only ever included real stored values.
// Rooms aren't their own managed entity otherwise (just whatever string
// is typed into each class's room field), so this is still derived, not a
// fixed table, same idea as Edit Hours.
async function roomsForDay(day) {
  const named = (
    await db
      .prepare("SELECT DISTINCT room, LOWER(room) AS \"sortRoom\" FROM classes WHERE day = ? AND room IS NOT NULL AND room != '' ORDER BY \"sortRoom\"")
      .all(day)
  ).map((r) => r.room);
  const hasUnassigned = await db.prepare("SELECT 1 FROM classes WHERE day = ? AND (room IS NULL OR room = '') LIMIT 1").get(day);
  return hasUnassigned ? [...named, UNASSIGNED_ROOM] : named;
}

// Renames a room across every class on a day that currently uses it - the
// bulk-edit half of "Edit Room Numbers". Renaming FROM the synthetic
// "Unassigned" bucket (see roomsForDay above) instead assigns every
// currently-blank-room class on that day to the new name - the only way
// those classes can get a real room without editing them one at a time.
// Also carries the rename into any saved custom room order, so a
// reordered "Kitchen" row doesn't reset to the alphabetical default just
// because it got renamed.
async function renameRoom(day, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  if (oldName === UNASSIGNED_ROOM) {
    await db.prepare("UPDATE classes SET room = ? WHERE day = ? AND (room IS NULL OR room = '')").run(newName, day);
  } else {
    await db.prepare('UPDATE classes SET room = ? WHERE day = ? AND room = ?').run(newName, day, oldName);
  }
  const order = await getRoomOrder(day);
  if (order.includes(oldName)) {
    await saveRoomOrder(day, order.map((r) => (r === oldName ? newName : r)));
  }
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

// Snapshots each of the given classes into class_schedule_archives, then
// deletes it from the live schedule (deleteClass, so its roster gets the
// same deactivation any other deleted class's does) - the selection-based
// alternative to deleting classes one at a time by hand, e.g. clearing a
// day before a fresh Import Classes run without losing the record of
// what was there. Teacher/assistant names are flattened to a comma-joined
// string and enrollment to a plain count rather than kept as live
// class_staff/class_enrollments references - see the table's own
// migration comment on why. Returns how many were archived.
async function archiveClasses(classIds) {
  let archived = 0;
  for (const id of classIds) {
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!cls) continue;
    const staff = await staffForClass(id);
    const students = await studentsForClass(id);
    await db
      .prepare(
        `INSERT INTO class_schedule_archives
           (day, class_name, room, age_group, color, notes, start_time, end_time, teachers, assistants, student_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cls.day,
        cls.class_name,
        cls.room,
        cls.age_group,
        cls.color,
        cls.notes,
        cls.start_time,
        cls.end_time,
        staff.filter((s) => s.role === 'teacher').map((s) => s.name).join(', ') || null,
        staff.filter((s) => s.role === 'assistant').map((s) => s.name).join(', ') || null,
        students.length
      );
    await deleteClass(id);
    archived++;
  }
  return archived;
}

// One row of the Class Archive tab's list.
async function listClassArchives() {
  return db.prepare('SELECT * FROM class_schedule_archives ORDER BY archived_at DESC, id DESC').all();
}

async function deleteClassArchive(id) {
  await db.prepare('DELETE FROM class_schedule_archives WHERE id = ?').run(id);
}

async function deleteAllClassArchives() {
  const result = await db.prepare('DELETE FROM class_schedule_archives').run();
  return result.changes;
}

// skipSync - see addStaff's comment on the same option just below; the
// full day-level rebuild is skipped here for the identical reason (a bulk
// caller doing this once per row instead of once for the whole import).
async function setEnrollment(classId, studentIds, { skipSync } = {}) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM class_enrollments WHERE class_id = ?').run(classId);
    const link = tx.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?) ON CONFLICT (class_id, student_id) DO NOTHING');
    for (const studentId of studentIds) await link.run(classId, studentId);
  });
  await syncClassRosterMembers(classId);
  if (skipSync) return;
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

// A member picked up as a class's teacher/assistant for an hour they were
// already on that day's Floater Assignments list for is no longer free to
// float that hour - drop just that one hour's floater assignment (not the
// member's whole floater-list membership, which may still cover other
// hours) so they don't read as double-booked. A no-op if they weren't on
// that list/hour to begin with, or if the day has no Floater Assignments
// list set up yet.
async function removeFromFloaterForHour(day, hourPosition, memberId) {
  const list = await getListByDay(day);
  if (!list) return;
  const section = (await sectionsForList(list.id)).find((s) => s.position === hourPosition);
  if (!section) return;
  await removeMemberFromSection(list.id, memberId, section.id);
}

// Adds one teacher/assistant - used by both the admin manage form (one at
// a time, via the picker) and the public self-signup page. syncDayMemberRosters
// rebuilds that whole day's rosters/schedules from scratch (every class,
// every student and staff member on it), so it's cheap for this one-at-a-
// time case but far too expensive to run after every single row of a bulk
// import - skipSync lets a bulk caller (Class Schedule Import) insert the
// class_staff rows directly and run just one sync at the end instead of
// one per staff member added.
async function addStaff(classId, memberId, role, { skipSync } = {}) {
  await db
    .prepare(
      `INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)
       ON CONFLICT (class_id, member_id) DO UPDATE SET role = excluded.role`
    )
    .run(classId, memberId, role === 'assistant' ? 'assistant' : 'teacher');
  const cls = await db.prepare('SELECT day, hour_position FROM classes WHERE id = ?').get(classId);
  if (cls) await removeFromFloaterForHour(cls.day, cls.hour_position, memberId);
  if (skipSync) return;
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

// Every class on this day whose ASSIGNED teacher and/or assistant is
// absent/late on `date` - drives the Attendance page's "Substitutes
// Needed" log. Not the same thing as a class that was simply never given
// an assistant by design (that's a staffing-plan gap, not something a
// substitute needs to cover) - only someone who IS assigned and can't
// make it today counts, same "missing" signal substituteBoard uses to
// decide a slot needs a floater. No date (or nothing missing yet) means
// nothing needs covering.
async function classesNeedingStaffForDay(day, date) {
  const hours = await gridForDay(day);
  const missingById = date ? await missingMemberIdsForDate(date) : new Map();
  const result = [];
  hours.forEach((h) => {
    h.classes.forEach((cls) => {
      const missingTeacher = cls.staff.some((s) => s.role === 'teacher' && missingById.has(s.id));
      const missingAssistant = cls.staff.some((s) => s.role === 'assistant' && missingById.has(s.id));
      if (missingTeacher || missingAssistant) {
        result.push({
          hourLabel: h.label,
          className: cls.class_name,
          room: cls.room,
          missingTeacher,
          missingAssistant,
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

// Every class on this day where enough students have submitted an
// Absence form for `date` to leave 3 or fewer expected - flags classes
// that may need to be canceled for low turnout, i.e. all but 3 (or fewer)
// of its students are out. Requires at least one actual absence-form
// submission - a class that's simply small by design (3 or fewer
// students enrolled to begin with) is not "at risk", it's just a small
// class with full attendance. Deliberately narrower than "marked absent"
// generally (absentMemberIdsForDate, which also covers a kiosk no-show
// mark) - cancellation risk should only react to a parent proactively
// saying their kid won't be there, not every way a student can end up
// absent. Counts both students who've already checked in and those who
// haven't checked in yet, only excluding those with an absence form on
// file for that date.
async function classesAtRiskForDay(day, date) {
  const hours = await gridForDay(day);
  const absentIds = date ? await absenceFormAbsentMemberIdsForDate(date) : new Set();
  const result = [];
  hours.forEach((h) => {
    h.classes.forEach((cls) => {
      if (cls.students.length === 0) return;
      const absentCount = cls.students.filter((s) => absentIds.has(s.id)).length;
      const expectedCount = cls.students.length - absentCount;
      if (absentCount > 0 && expectedCount <= 3) {
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

// Everyone who submitted an Absence form (not a Late form - someone
// running late is still coming) for a given date - classesAtRiskForDay's
// own narrower "actually won't be there" signal, based specifically on a
// submitted form rather than any way a student can end up marked absent.
async function absenceFormAbsentMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    (
      await db
        .prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND source = 'absence_form' AND status = 'absent'`)
        .all(date)
    ).map((r) => r.member_id)
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
  const dayParam = day || null;
  const rows = await db
    .prepare(
      `SELECT c.*, h.label AS "hourLabel",
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS "studentCount"
       FROM classes c
       JOIN class_schedule_hours h ON h.day = c.day AND h.position = c.hour_position
       WHERE (?::text IS NULL OR c.day = ?::text)
       ORDER BY LOWER(c.class_name)`
    )
    .all(dayParam, dayParam);
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

// A parent whose schedule has a hour with no class of their own that day
// (not enrolled as a student there, not teaching/assisting a class there)
// that falls within their family's overall attendance window (the same
// earliest-class-start-to-latest-class-end span arrivalDepartureLabels
// computes, from every family member's own classes that day) gets
// automatically placed on that hour's Floater Assignments section - a
// parent shouldn't have to be hand-added to floater just because they're
// on-site dropping a kid off before their own class or waiting to pick
// one up after it. Additive only: it never removes an assignment, however
// it got there - the one place a floater assignment is automatically
// dropped is removeFromFloaterForHour, when that same hour gets a real
// teacher/assistant assignment instead. Runs as part of syncDayMemberRosters,
// so it fires on every enrollment/staffing change for the day, not on a
// standalone schedule.
// The shared groundwork both autoAssignFloatersForDay and utils/schedule.
// js's arrivalDepartureLabels (via familyAttendanceWindowsForDay below)
// build on: every member's real class positions that day (enrolled as a
// student, or teaching/assisting), each hour position's live-derived
// time range, and each family's resulting attendance window (earliest
// start / latest end across every member of the family). Deliberately
// does NOT fold in floater assignments - autoAssignFloatersForDay needs
// the window as defined by real class assignments only, to decide which
// blank hours to floater-fill in the first place.
async function ownPositionsAndFamilyWindowsForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  const positionRanges = derivedHourTimeRanges(classes, await hoursForDay(day));
  const classIds = classes.map((c) => c.id);
  const classById = {};
  classes.forEach((c) => { classById[c.id] = c; });

  const ownPositionsByMember = {};
  const noteOwn = (memberId, position) => {
    if (!ownPositionsByMember[memberId]) ownPositionsByMember[memberId] = new Set();
    ownPositionsByMember[memberId].add(position);
  };
  if (classIds.length) {
    const placeholders = classIds.map(() => '?').join(',');
    (await db.prepare(`SELECT class_id, student_id FROM class_enrollments WHERE class_id IN (${placeholders})`).all(...classIds)).forEach((r) => {
      const cls = classById[r.class_id];
      if (cls) noteOwn(r.student_id, cls.hour_position);
    });
    (await db.prepare(`SELECT class_id, member_id FROM class_staff WHERE class_id IN (${placeholders})`).all(...classIds)).forEach((r) => {
      const cls = classById[r.class_id];
      if (cls) noteOwn(r.member_id, cls.hour_position);
    });
  }

  const memberIds = Object.keys(ownPositionsByMember).map(Number);
  const familyIdByMember = {};
  if (memberIds.length) {
    const memberPlaceholders = memberIds.map(() => '?').join(',');
    (await db.prepare(`SELECT id, family_id FROM members WHERE id IN (${memberPlaceholders})`).all(...memberIds)).forEach((r) => {
      familyIdByMember[r.id] = r.family_id;
    });
  }

  const windowByFamily = {};
  memberIds.forEach((memberId) => {
    const familyId = familyIdByMember[memberId];
    if (!familyId) return;
    ownPositionsByMember[memberId].forEach((position) => {
      const range = positionRanges[position];
      if (!range) return;
      const w = windowByFamily[familyId] || { start: null, end: null };
      extendWindow(w, range);
      windowByFamily[familyId] = w;
    });
  });

  return { positionRanges, ownPositionsByMember, familyIdByMember, windowByFamily };
}

// Widens a { start, end } window (minutes-since-midnight, either half
// possibly still null) to also cover a position's range - start always
// participates (a class's start time is always known once it resolves at
// all), but end only participates when range.endMin is a real, known
// value. A range with no real end (see derivedHourTimeRanges) must never
// narrow or fabricate a window's end - better an honestly-blank departure
// than a confidently wrong one built from some other class's start time.
function extendWindow(w, range) {
  if (w.start == null || range.startMin < w.start) w.start = range.startMin;
  if (range.endMin != null && (w.end == null || range.endMin > w.end)) w.end = range.endMin;
}

// Every member's live attendance window for a day (earliest start /
// latest end, in minutes-since-midnight) - their family's real-class
// window (see ownPositionsAndFamilyWindowsForDay above) extended to also
// cover any floater hour they or a family member currently hold, since
// floating a hour means being physically there for it too. Computed
// fresh from current class/enrollment/staffing/floater data on every
// call, never read back from the separately-cached member_schedules
// table - that table only gets rebuilt when enrollment/staffing/floater
// assignments actually change, so a family that hasn't been touched
// since a fix like this one landed would otherwise keep showing whatever
// was cached under the old (buggy) logic. Returns { [memberId]: { start,
// end } }; a member with nothing resolvable on the schedule is simply
// absent from the map. Used by utils/schedule.js's arrivalDepartureLabels.
async function familyAttendanceWindowsForDay(day) {
  const { positionRanges, ownPositionsByMember, familyIdByMember, windowByFamily } = await ownPositionsAndFamilyWindowsForDay(day);

  const list = await getListByDay(day);
  if (list) {
    for (const section of await sectionsForList(list.id)) {
      for (const memberId of await membersForSectionRaw(list.id, section.id)) {
        if (!ownPositionsByMember[memberId]) ownPositionsByMember[memberId] = new Set();
        ownPositionsByMember[memberId].add(section.position);
        if (!(memberId in familyIdByMember)) {
          const row = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
          familyIdByMember[memberId] = row ? row.family_id : null;
        }
        const range = positionRanges[section.position];
        if (!range) continue;
        const familyId = familyIdByMember[memberId];
        if (familyId == null) continue;
        const w = windowByFamily[familyId] || { start: null, end: null };
        extendWindow(w, range);
        windowByFamily[familyId] = w;
      }
    }
  }

  const result = {};
  Object.keys(ownPositionsByMember).forEach((memberIdStr) => {
    const memberId = Number(memberIdStr);
    const familyId = familyIdByMember[memberId];
    if (familyId != null && windowByFamily[familyId]) {
      result[memberId] = windowByFamily[familyId];
      return;
    }
    // No family on file - fall back to just this member's own positions.
    let w = null;
    ownPositionsByMember[memberId].forEach((position) => {
      const range = positionRanges[position];
      if (!range) return;
      if (!w) w = { start: null, end: null };
      extendWindow(w, range);
    });
    if (w) result[memberId] = w;
  });
  return result;
}

async function autoAssignFloatersForDay(day) {
  const list = await getListByDay(day);
  if (!list) return;
  const sections = await sectionsForList(list.id);
  if (!sections.length) return;
  const sectionByPosition = {};
  sections.forEach((s) => { sectionByPosition[s.position] = s; });

  const { positionRanges, ownPositionsByMember, windowByFamily } = await ownPositionsAndFamilyWindowsForDay(day);
  if (!Object.keys(ownPositionsByMember).length) return;

  // Only the family's designated primary parent gets auto-floated - a
  // family with 2 parents shouldn't end up with both of them
  // individually placed on every blank hour.
  const primaryParentIdByFamily = await primaryParentIdsByFamily(Object.keys(windowByFamily).map(Number));
  for (const [familyId, parentId] of Object.entries(primaryParentIdByFamily)) {
    const window = windowByFamily[familyId];
    if (!window || window.start == null || window.end == null) continue;
    const ownPositions = ownPositionsByMember[parentId] || new Set();
    for (const [positionStr, range] of Object.entries(positionRanges)) {
      const position = Number(positionStr);
      if (ownPositions.has(position)) continue;
      const section = sectionByPosition[position];
      if (!section) continue;
      const overlapsWindow = range.startMin < window.end && range.endMin > window.start;
      if (!overlapsWindow) continue;
      await addMemberToSection(list.id, parentId, section.id);
    }
  }
}

// The family's designated primary parent id (Members page's own
// is_primary_parent flag, same "one point of contact per family"
// convention utils/scheduleCardData.js's primaryParentFor uses), falling
// back to whichever active parent in the family comes first
// alphabetically if nobody's been marked primary yet, so a family is
// never left with no representative just because that flag hasn't been
// set. { [familyId]: memberId } for every familyId passed in that has at
// least one active parent - a family with none is simply absent from the
// result. Shared by autoAssignFloatersForDay (above) and
// syncDayMemberRosters (below), so "who represents this family" is
// answered the same way everywhere it matters.
async function primaryParentIdsByFamily(familyIds) {
  const ids = familyIds.filter((id) => id != null);
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const allParents = await db
    .prepare(
      `SELECT id, family_id, is_primary_parent, name FROM members
       WHERE active = 1 AND member_type = 'parent' AND family_id IN (${placeholders}) ORDER BY LOWER(name)`
    )
    .all(...ids);
  const byFamily = {};
  allParents.forEach((p) => {
    const current = byFamily[p.family_id];
    if (!current || (p.is_primary_parent && !current.is_primary_parent)) byFamily[p.family_id] = p;
  });
  const result = {};
  Object.entries(byFamily).forEach(([familyId, p]) => { result[familyId] = p.id; });
  return result;
}

// Removes any parent who isn't their family's designated primary parent
// from EVERY floater hour section on a day, no matter how they got there.
// autoAssignFloatersForDay only ever adds (see its own comment) and has no
// way to tell an old, now-wrong auto-added assignment from a deliberate
// manual one - volunteer_members has no 'source' column the way
// roster_members does for syncDayMemberRosters's own auto-vs-manual
// distinction - so once a family had both parents floated (whether by an
// earlier version of the auto-assign logic or a bulk import), nothing
// short of this explicit, admin-triggered cleanup ever removes the extra
// one. Not automatic, and not run as part of any regular sync - only from
// the Floater Teams page's own confirm-guarded "Remove Non-Primary
// Parents" button. Returns the number of (member, section) memberships
// removed.
async function removeNonPrimaryParentsFromFloaterTeams(day) {
  const list = await getListByDay(day);
  if (!list) return 0;
  const sections = await sectionsForList(list.id);
  if (!sections.length) return 0;

  const memberIdsBySection = {};
  const allMemberIds = new Set();
  for (const section of sections) {
    const ids = await membersForSectionRaw(list.id, section.id);
    memberIdsBySection[section.id] = ids;
    ids.forEach((id) => allMemberIds.add(id));
  }
  if (!allMemberIds.size) return 0;

  const placeholders = Array.from(allMemberIds).map(() => '?').join(',');
  const parents = await db
    .prepare(`SELECT id, family_id FROM members WHERE id IN (${placeholders}) AND member_type = 'parent'`)
    .all(...allMemberIds);
  const familyIdByParent = {};
  parents.forEach((p) => { familyIdByParent[p.id] = p.family_id; });
  const familyIds = [...new Set(parents.map((p) => p.family_id).filter((id) => id != null))];
  const primaryIds = new Set(Object.values(await primaryParentIdsByFamily(familyIds)));

  let removed = 0;
  for (const section of sections) {
    for (const memberId of memberIdsBySection[section.id]) {
      // Not a parent record, or a parent with no family on file - nothing
      // to compare against "who's primary," so leave it alone rather than
      // guessing.
      if (!(memberId in familyIdByParent) || familyIdByParent[memberId] == null) continue;
      if (primaryIds.has(memberId)) continue;
      await removeMemberFromSection(list.id, memberId, section.id);
      removed++;
    }
  }
  if (removed) await syncDayMemberRosters(day);
  return removed;
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
  await autoAssignFloatersForDay(day);
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
  // A parent belongs on this day's roster not only for teaching/assisting
  // a class themselves, but whenever ANYONE in their family does -
  // dropping off/picking up an enrolled kid means they're at the co-op
  // that day too, even if they have no class assignment of their own.
  // Only the family's designated primary parent represents them here
  // though - a family with 2 active parents shouldn't put both of them
  // on the roster just because one kid is enrolled in a class.
  if (studentIds.size > 0) {
    const studentPlaceholders = Array.from(studentIds).map(() => '?').join(',');
    const familyIds = new Set(
      (
        await db
          .prepare(`SELECT DISTINCT family_id FROM members WHERE id IN (${studentPlaceholders}) AND family_id IS NOT NULL`)
          .all(...studentIds)
      ).map((r) => r.family_id)
    );
    if (familyIds.size > 0) {
      Object.values(await primaryParentIdsByFamily(Array.from(familyIds))).forEach((id) => parentIds.add(id));
    }
  }
  (await floaterMemberIdsForDay(day)).forEach((id) => parentIds.add(id));
  await setRosterMembership(await ensureDayRoster(day, 'student'), studentIds);
  await setRosterMembership(await ensureDayRoster(day, 'parent'), parentIds);
  await syncMemberSchedulesForDay(day);
}

// The real, parseable start/end time for each hour position on a day,
// derived live from whichever class at that position has the earliest
// parseable start_time - the same live-derivation roomGridForDay already
// does for its own column headers, and for the same reason: the
// separately-stored class_schedule_hours label only gets refreshed at
// import time, so it's easy for it to sit stuck on the generic "Hour N"
// default (or a stale time) while classes with real times exist at that
// position. A class entered without its own start_time/end_time borrows
// this derived range instead of falling straight back to that label -
// arrivalDepartureLabels (utils/schedule.js) can't parse "Hour N" as a
// clock time, so any row stuck on it was silently dropped from a family's
// earliest/latest calculation.
// hours (a day's class_schedule_hours rows, each carrying its own shared
// start_time/end_time - see saveHourLabels) is optional and defaults to
// none, for callers that only have classes on hand.
// { [position]: { startMin, endMin, label } } - endMin/label omitted when
// neither any class at that position nor the hour itself has a parseable
// end_time to pair with a start.
function derivedHourTimeRanges(rawClasses, hours = []) {
  const bestByPosition = {};
  rawClasses.forEach((cls) => {
    const startMinutes = parseClockMinutesLocal(cls.start_time);
    if (startMinutes == null) return;
    const current = bestByPosition[cls.hour_position];
    if (!current || startMinutes < current.startMinutes) {
      bestByPosition[cls.hour_position] = { startMinutes, endTime: cls.end_time };
    }
  });
  const ranges = {};
  Object.entries(bestByPosition).forEach(([position, { startMinutes, endTime }]) => {
    const endMinutes = parseClockMinutesLocal(endTime);
    // No parseable end time entered for any class at this position - endMin
    // is left null rather than defaulting to the start time. It used to
    // default to startMinutes (a zero-length "range"), which fed straight
    // into familyAttendanceWindowsForDay's max-end-time calculation as if
    // it were a real, if early, departure - so a co-op that only ever fills
    // in Start Time got a confidently wrong Departure (the start time of a
    // family's last class) instead of an honestly blank one. Every caller
    // of positionRanges treats a null endMin as "unknown," not "zero."
    ranges[position] = endMinutes != null
      ? { startMin: startMinutes, endMin: endMinutes, label: `${minutesToClockLabelLocal(startMinutes)} - ${minutesToClockLabelLocal(endMinutes)}` }
      : { startMin: startMinutes, endMin: null, label: minutesToClockLabelLocal(startMinutes) };
  });

  // The hour row's own shared Start/End Time (Class Schedule page's Edit
  // Hours dialog) is the default every class in that position uses -
  // fills in a position with no parseable time from any class at all
  // (the common case: no class at that position sets its own times), and
  // fills in just the missing end when the position's earliest-starting
  // class has its own start but no end. A class with BOTH its own start
  // and end fully overrides the hour default, already handled above
  // before this loop runs.
  hours.forEach((h) => {
    const existing = ranges[h.position];
    const hourEnd = parseClockMinutesLocal(h.end_time);
    if (!existing) {
      const hourStart = parseClockMinutesLocal(h.start_time);
      if (hourStart == null) return;
      ranges[h.position] = hourEnd != null
        ? { startMin: hourStart, endMin: hourEnd, label: `${minutesToClockLabelLocal(hourStart)} - ${minutesToClockLabelLocal(hourEnd)}` }
        : { startMin: hourStart, endMin: null, label: minutesToClockLabelLocal(hourStart) };
    } else if (existing.endMin == null && hourEnd != null) {
      existing.endMin = hourEnd;
      existing.label = `${minutesToClockLabelLocal(existing.startMin)} - ${minutesToClockLabelLocal(hourEnd)}`;
    }
  });
  return ranges;
}

function derivedHourTimeLabels(rawClasses, hours = []) {
  const labels = {};
  Object.entries(derivedHourTimeRanges(rawClasses, hours)).forEach(([position, range]) => { labels[position] = range.label; });
  return labels;
}

async function rawHourLabel(day, position) {
  const hour = await db.prepare('SELECT label FROM class_schedule_hours WHERE day = ? AND position = ?').get(day, position);
  return (hour && hour.label) || '';
}

// A class's display time range: its own start_time/end_time if an admin
// set them, otherwise the position's live-derived time (see
// derivedHourTimeLabels above), otherwise its hour block's raw stored
// label (e.g. "Hour 1" or whatever an admin renamed it to via Edit
// Hours).
async function timeRangeForClass(cls) {
  if (cls.start_time && cls.end_time) return `${cls.start_time} - ${cls.end_time}`;
  const siblings = await db
    .prepare('SELECT hour_position, start_time, end_time FROM classes WHERE day = ? AND hour_position = ?')
    .all(cls.day, cls.hour_position);
  const hour = await db.prepare('SELECT position, start_time, end_time FROM class_schedule_hours WHERE day = ? AND position = ?').get(cls.day, cls.hour_position);
  const derived = derivedHourTimeLabels(siblings, hour ? [hour] : [])[cls.hour_position];
  return derived || (await rawHourLabel(cls.day, cls.hour_position));
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
async function syncMemberSchedulesForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  const hours = await hoursForDay(day);
  const derivedLabels = derivedHourTimeLabels(classes, hours);
  await db.prepare('DELETE FROM member_schedules WHERE day = ?').run(day);
  const upsert = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, now_text())
     ON CONFLICT(member_id, day, class_number) DO UPDATE SET
       time = excluded.time, class_name = excluded.class_name, room = excluded.room,
       teacher = excluded.teacher, updated_at = now_text()`
  );

  for (const cls of classes) {
    const time = (cls.start_time && cls.end_time)
      ? `${cls.start_time} - ${cls.end_time}`
      : derivedLabels[cls.hour_position] || (await rawHourLabel(day, cls.hour_position));
    const staff = await staffForClass(cls.id);
    const teacherNames = staff.filter((s) => s.role === 'teacher').map((s) => s.name).join(', ');
    const people = [...(await studentsForClass(cls.id)), ...staff];
    for (const person of people) {
      await upsert.run(person.id, day, cls.hour_position, time, cls.class_name, cls.room || '', teacherNames);
    }
  }

  const insertIfEmpty = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, 'Floater', '', '', now_text())
     ON CONFLICT(member_id, day, class_number) DO NOTHING`
  );
  const list = await getListByDay(day);
  if (list) {
    const hourLabels = {};
    hours.forEach((h) => { hourLabels[h.position] = derivedLabels[h.position] || h.label; });
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
  getRoomOrder,
  saveRoomOrder,
  getClass,
  createClass,
  colorForClassName,
  updateClass,
  deleteClass,
  archiveClasses,
  listClassArchives,
  deleteClassArchive,
  deleteAllClassArchives,
  setEnrollment,
  addStaff,
  removeFromFloaterForHour,
  autoAssignFloatersForDay,
  removeNonPrimaryParentsFromFloaterTeams,
  familyAttendanceWindowsForDay,
  minutesToClockLabelLocal,
  removeStaff,
  activeStudents,
  activeParentsForStaff,
  staffListForDay,
  classesNeedingStaffForDay,
  classesAtRiskForDay,
  absentMemberIdsForDate,
  absenceFormMemberIdsForDate,
  absenceFormAbsentMemberIdsForDate,
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

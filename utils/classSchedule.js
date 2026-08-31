const db = require('../db');
const { DAYS, DAY_LABELS, isValidDay, defaultDay } = require('./days');
const { getListByDay, sectionsForList, membersForList, removeMemberFromSection, addMemberToSection, excludedFloaterPairsForList } = require('./volunteers');
const { byLastName } = require('./members');

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
  return (
    await db
      .prepare(
        `SELECT m.*, f.name AS family_name, ce.created_at AS enrolled_at FROM class_enrollments ce
         JOIN members m ON m.id = ce.student_id
         LEFT JOIN families f ON f.id = m.family_id
         WHERE ce.class_id = ? AND m.active = 1`
      )
      .all(classId)
  ).sort(byLastName);
}

async function staffForClass(classId) {
  const rows = await db
    .prepare(
      `SELECT m.*, cs.role FROM class_staff cs
       JOIN members m ON m.id = cs.member_id
       WHERE cs.class_id = ? AND m.active = 1`
    )
    .all(classId);
  // Same role-then-name order the old ORDER BY cs.role, LOWER(m.name) gave -
  // just with the name tiebreak swapped for last-name.
  return rows.sort((a, b) => a.role.localeCompare(b.role) || byLastName(a, b));
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
// Tolerates an optional ":SS" seconds component (discarded) - see
// utils/schedule.js's copy of this same regex for why: a spreadsheet cell
// formatted as Excel's h:mm:ss AM/PM reads back as "10:00:00 AM" once
// utils/spreadsheetWorker.js uses formatted text instead of a raw serial,
// and that's a real, common time format, not an edge case to reject.
function parseClockMinutesLocal(raw) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\s*$/.exec(String(raw || ''));
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

// A { startMin, endMin } range (see effectiveClassRange/hourOnlyRange
// below) as a display string - "9:00 AM - 9:45 AM", or just "9:00 AM"
// when endMin is unknown (never fabricated). null in, null out, so a
// caller can chain a further fallback (e.g. `|| someLabel`) on the
// result without an extra null check of its own.
function rangeToLabel(range) {
  if (!range) return null;
  return range.endMin != null
    ? `${minutesToClockLabelLocal(range.startMin)} - ${minutesToClockLabelLocal(range.endMin)}`
    : minutesToClockLabelLocal(range.startMin);
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
      `INSERT INTO classes (day, hour_position, class_name, room, age_group, color, notes, start_time, end_time, capacity, registration_open, description,
         allow_parent_register, allow_teacher_register, allow_student_register, teacher_slots, assistant_slots, min_capacity, allow_cancel, auto_refund_on_cancel, price_cents, price_per)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      fields.endTime || null,
      fields.capacity || null,
      fields.registrationOpen ? 1 : 0,
      fields.description || null,
      fields.allowParentRegister === false ? 0 : 1,
      fields.allowTeacherRegister === false ? 0 : 1,
      fields.allowStudentRegister ? 1 : 0,
      fields.teacherSlots || null,
      fields.assistantSlots || null,
      fields.minCapacity || null,
      fields.allowCancel === false ? 0 : 1,
      fields.autoRefundOnCancel ? 1 : 0,
      fields.priceCents || null,
      fields.pricePer === 'family' ? 'family' : 'person'
    );
  const id = info.lastInsertRowid;
  await ensureClassRoster(id);
  return id;
}

async function updateClass(id, fields) {
  const before = await db.prepare('SELECT roster_id, day FROM classes WHERE id = ?').get(id);
  await db.prepare(
    `UPDATE classes SET day = ?, hour_position = ?, class_name = ?, room = ?, age_group = ?, color = ?, notes = ?, start_time = ?, end_time = ?, capacity = ?, registration_open = ?, description = ?,
       allow_parent_register = ?, allow_teacher_register = ?, allow_student_register = ?, teacher_slots = ?, assistant_slots = ?, min_capacity = ?, allow_cancel = ?, auto_refund_on_cancel = ?, price_cents = ?, price_per = ?
     WHERE id = ?`
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
    fields.capacity || null,
    fields.registrationOpen ? 1 : 0,
    fields.description || null,
    fields.allowParentRegister === false ? 0 : 1,
    fields.allowTeacherRegister === false ? 0 : 1,
    fields.allowStudentRegister ? 1 : 0,
    fields.teacherSlots || null,
    fields.assistantSlots || null,
    fields.minCapacity || null,
    fields.allowCancel === false ? 0 : 1,
    fields.autoRefundOnCancel ? 1 : 0,
    fields.priceCents || null,
    fields.pricePer === 'family' ? 'family' : 'person',
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
    const teacherNames = staff.filter((s) => s.role === 'teacher').map((s) => s.name).join(', ') || null;
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
        teacherNames,
        staff.filter((s) => s.role === 'assistant').map((s) => s.name).join(', ') || null,
        students.length
      );
    // One row per student who completed this class - the only source of
    // past-term Transcript data (see student_academic_history's own
    // migration comment), written here because this is the one place a
    // class's enrollment is still live at the moment it's retired.
    for (const student of students) {
      await db
        .prepare('INSERT INTO student_academic_history (student_id, class_name, day, age_group, teacher_names) VALUES (?, ?, ?, ?, ?)')
        .run(student.id, cls.class_name, cls.day, cls.age_group, teacherNames);
    }
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
  // A student enrolled here used to never get cleared off the Floater
  // Assignments list at all (unlike addStaff's own teacher/assistant
  // pickup, just below) - see floaterPositionsCoveredByClass's own
  // comment on why this also covers a position the class overlaps but
  // isn't literally filed under. Computed once for the whole class, not
  // once per student.
  const { day, positions } = await floaterPositionsCoveredByClass(classId);
  if (day) {
    for (const studentId of studentIds) {
      for (const position of positions) await removeFromFloaterForHour(day, position, studentId);
    }
  }
  if (skipSync) return;
  if (day) await syncDayMemberRosters(day);
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

// A class's own hour_position, plus every OTHER position its own
// effective time genuinely overlaps (see positionsOverlappingRange) - the
// full set of positions a member picked up for this class needs clearing
// off the Floater Assignments list for. { day, positions: Set<number> },
// or { day: null, positions: new Set() } if the class doesn't exist.
async function floaterPositionsCoveredByClass(classId) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) return { day: null, positions: new Set() };
  const hours = await hoursForDay(cls.day);
  const hourByPosition = {};
  hours.forEach((h) => { hourByPosition[h.position] = h; });
  const positions = positionsOverlappingRange(effectiveClassRange(cls, hourByPosition), hourByPosition);
  positions.add(cls.hour_position);
  return { day: cls.day, positions };
}

async function removeFromFloaterForOverlappingHours(classId, memberId) {
  const { day, positions } = await floaterPositionsCoveredByClass(classId);
  if (!day) return;
  for (const position of positions) await removeFromFloaterForHour(day, position, memberId);
}

// Adds one teacher/assistant - used by both the admin manage form (one at
// a time, via the picker) and the public self-signup page. syncDayMemberRosters
// rebuilds that whole day's rosters/schedules from scratch (every class,
// every student and staff member on it), so it's cheap for this one-at-a-
// time case but far too expensive to run after every single row of a bulk
// import - skipSync lets a bulk caller (Class Schedule Import) insert the
// class_staff rows directly and run just one sync at the end instead of
// one per staff member added. syncClassRosterMembers (this one class, so
// cheap either way) always runs regardless of skipSync, same as
// setEnrollment's own pattern - a bulk import still needs this class's
// own roster to pick up its new teacher/assistant immediately, only the
// day-wide rebuild is worth batching.
async function addStaff(classId, memberId, role, { skipSync } = {}) {
  await db
    .prepare(
      `INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)
       ON CONFLICT (class_id, member_id) DO UPDATE SET role = excluded.role`
    )
    .run(classId, memberId, role === 'assistant' ? 'assistant' : 'teacher');
  await removeFromFloaterForOverlappingHours(classId, memberId);
  await syncClassRosterMembers(classId);
  if (skipSync) return;
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

async function removeStaff(classId, memberId) {
  await db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(classId, memberId);
  await syncClassRosterMembers(classId);
  const cls = await db.prepare('SELECT day FROM classes WHERE id = ?').get(classId);
  if (cls) await syncDayMemberRosters(cls.day);
}

// Active students, for the enrollment picker.
async function activeStudents() {
  return (await db.prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'student'").all()).sort(byLastName);
}

// Active parents, admins, AND students, for the teacher/assistant picker -
// a homeschool co-op commonly has a teen student teaching or assisting a
// younger class alongside (or instead of) a parent, so student is eligible
// here too. Admins are included alongside parents for the same reason
// every other member/parent picker site-wide now is - "admins should
// still be included in lists of members/parents etc. for selecting
// ANYTHING across the site" - admins regularly teach or assist a class
// themselves. Each row carries its own member_type so a picker can label
// a student option distinctly from a parent/admin one with the same or a
// similar name.
async function activeMembersForStaff() {
  return (
    await db
      .prepare("SELECT id, name, member_type FROM members WHERE active = 1 AND member_type IN ('parent', 'admin', 'student')")
      .all()
  ).sort(byLastName);
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

// Everyone with an actual kiosk check-in recorded on a given date - a real
// request: "highlight the member row red if they check in that day" on the
// Setup/Cleanup Assignments roster (see setup.js's assignmentCardsForDate).
// Same shape as absentMemberIdsForDate above, just keyed off check_in_time
// instead of status = 'absent'.
async function checkedInMemberIdsForDate(date) {
  if (!date) return new Set();
  return new Set(
    (
      await db.prepare(`SELECT DISTINCT member_id FROM attendance WHERE session_date = ? AND check_in_time IS NOT NULL`).all(date)
    ).map((r) => r.member_id)
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
  // A real bug report: "Could not add member: duplicate key value
  // violates unique constraint 'roster_members_pkey'" every time a
  // class's enrollment/staffing changed. roster_members' primary key is
  // (roster_id, member_id) - it has no idea a 'manual' row (added by
  // hand via the Attendance page's Add Member popup, or this class's own
  // roster Add Member dialog) is any different from an 'auto' one. This
  // used to only check 'auto' rows for "already here", so a member
  // already present via a manual add looked absent and got a second
  // INSERT attempt for the exact same (roster_id, member_id) pair,
  // colliding with the row that was already there. Checking every
  // existing row regardless of source fixes the insert side while the
  // remove side (below) still only ever considers 'auto' rows, so a
  // manually-added member still survives every resync exactly as
  // documented above.
  const rows = await db.prepare('SELECT member_id, source FROM roster_members WHERE roster_id = ?').all(rosterId);
  const allExistingIds = new Set(rows.map((r) => r.member_id));
  const autoIds = rows.filter((r) => r.source === 'auto').map((r) => r.member_id);
  const insert = db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')");
  const remove = db.prepare("DELETE FROM roster_members WHERE roster_id = ? AND member_id = ? AND source = 'auto'");
  for (const memberId of memberIdSet) {
    if (!allExistingIds.has(memberId)) await insert.run(rosterId, memberId);
  }
  for (const memberId of autoIds) {
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
  const rosterId = info.lastInsertRowid;
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(rosterId, classId);
  // A real request: a class roster's own session dates should always
  // match the day's Student roster - a class only ever meets when that
  // day's students do. routes/admin-rosters.js's dates/add route keeps
  // an EXISTING class roster in sync going forward, but a class created
  // (or re-created after its roster was deleted) AFTER dates already
  // exist for its day - the common case; a term's dates are usually set
  // up once, classes get added/edited after - would otherwise start with
  // none of its own. Copies whatever the Student roster already has at
  // creation time; ON CONFLICT DO NOTHING makes this safe to call even
  // if some of those dates somehow already made it in another way.
  const studentRosterId = await ensureDayRoster(cls.day, 'student');
  const existingDates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(studentRosterId);
  const insertDate = db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING');
  for (const row of existingDates) await insertDate.run(rosterId, row.session_date);
  return rosterId;
}

// Every class roster id meeting on a given day - dates added/removed on
// that day's Parent/Student rosters (routes/admin-rosters.js's dates/add
// and dates/:date/remove) should land on every one of these too, so a
// class roster's own roster_dates never drifts out of sync with the day
// it belongs to (see ensureClassRoster's own comment on why a class
// roster needs real rows here, not just a borrowed value at render time).
async function classRosterIdsForDay(day) {
  return (await db.prepare('SELECT roster_id FROM classes WHERE day = ? AND roster_id IS NOT NULL').all(day)).map((r) => r.roster_id);
}

// Genuine one-time backfill for an already-deployed database: before this
// fix, a class roster's own roster_dates was never written at all (only
// "borrowed" from the day's Student roster at a handful of specific read
// sites - the grid view, kiosk class check-in's own session-date check -
// rather than actually stored). A real bug report: utils/rosters.js's
// getMemberRostersForDate, which reads roster_dates directly for
// whichever roster it's asked about, could never find a class roster for
// any date no matter how many session dates the day itself had - it was
// simply never in that table. Copies each day's CURRENT Student roster
// dates onto every one of that day's class rosters; ON CONFLICT DO
// NOTHING makes re-running this (or the normal dates/add route, which
// keeps them in sync going forward) always safe.
async function backfillClassRosterDates() {
  for (const day of DAYS) {
    const studentRosterId = await ensureDayRoster(day, 'student');
    const dates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(studentRosterId);
    if (dates.length === 0) continue;
    const classRosterIds = await classRosterIdsForDay(day);
    if (classRosterIds.length === 0) continue;
    const insertDate = db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING');
    for (const classRosterId of classRosterIds) {
      for (const row of dates) await insertDate.run(classRosterId, row.session_date);
    }
  }
}

// Rebuilds a class's roster membership from its current enrollment AND
// staffing. A real request: "teachers and assistants should be able to
// be checked in on the class roster" - a class's own teacher(s)/
// assistant(s) (class_staff) used to never be part of its roster at all,
// only its enrolled students (class_enrollments), so they had no way to
// be checked in/out for that specific class (only the day-level Parent
// roster, via syncDayMemberRosters) - both feed the same roster_members
// table now, so resolveScan's own roster_members membership check (kiosk
// Class Check-In) and the admin class-tab roster both pick up staff for
// free with no changes of their own needed.
async function syncClassRosterMembers(classId) {
  const rosterId = await ensureClassRoster(classId);
  if (!rosterId) return;
  const memberIds = new Set(
    (await db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(classId)).map((r) => r.student_id)
  );
  (await db.prepare('SELECT member_id FROM class_staff WHERE class_id = ?').all(classId)).forEach((r) => memberIds.add(r.member_id));
  await setRosterMembership(rosterId, memberIds);
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
// A specific class's own effective time range: its own start_time/
// end_time where it has them, falling back independently per half to its
// hour position's shared default (see saveHourLabels) where it doesn't.
// Deliberately per-CLASS, not per-position - two classes can share the
// same hour_position (different rooms, running in parallel) with
// genuinely different lengths (a real bug report: one longer class
// sharing an hour with normal-length ones was polluting the *whole
// position's* derived range - see derivedHourTimeRanges's own "earliest
// start wins" position-level guess, which is fine for a display label but
// wrong as the source for any one specific family's own window). Returns
// null if neither the class nor its hour resolves to a real start time.
function effectiveClassRange(cls, hourByPosition) {
  const ownStart = parseClockMinutesLocal(cls.start_time);
  const ownEnd = parseClockMinutesLocal(cls.end_time);
  const hour = hourByPosition[cls.hour_position];
  const hourStart = hour ? parseClockMinutesLocal(hour.start_time) : null;
  const hourEnd = hour ? parseClockMinutesLocal(hour.end_time) : null;

  const startMin = ownStart != null ? ownStart : hourStart;
  if (startMin == null) return null;
  const endMin = ownEnd != null ? ownEnd : hourEnd;
  return { startMin, endMin };
}

async function ownPositionsAndFamilyWindowsForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  const hours = await hoursForDay(day);
  const positionRanges = derivedHourTimeRanges(classes, hours);
  const hourByPosition = {};
  hours.forEach((h) => { hourByPosition[h.position] = h; });
  const classIds = classes.map((c) => c.id);
  const classById = {};
  classes.forEach((c) => { classById[c.id] = c; });

  const ownPositionsByMember = {};
  const ownRangesByMember = {};
  const noteOwn = (memberId, cls) => {
    if (!ownPositionsByMember[memberId]) ownPositionsByMember[memberId] = new Set();
    ownPositionsByMember[memberId].add(cls.hour_position);
    const range = effectiveClassRange(cls, hourByPosition);
    if (range) {
      if (!ownRangesByMember[memberId]) ownRangesByMember[memberId] = [];
      ownRangesByMember[memberId].push(range);
    }
  };
  if (classIds.length) {
    const placeholders = classIds.map(() => '?').join(',');
    (await db.prepare(`SELECT class_id, student_id FROM class_enrollments WHERE class_id IN (${placeholders})`).all(...classIds)).forEach((r) => {
      const cls = classById[r.class_id];
      if (cls) noteOwn(r.student_id, cls);
    });
    (await db.prepare(`SELECT class_id, member_id FROM class_staff WHERE class_id IN (${placeholders})`).all(...classIds)).forEach((r) => {
      const cls = classById[r.class_id];
      if (cls) noteOwn(r.member_id, cls);
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
    (ownRangesByMember[memberId] || []).forEach((range) => {
      const w = windowByFamily[familyId] || { start: null, end: null };
      extendWindow(w, range);
      windowByFamily[familyId] = w;
    });
  });

  return { positionRanges, ownPositionsByMember, ownRangesByMember, familyIdByMember, windowByFamily, hourByPosition };
}

// A position's range from ONLY its own class_schedule_hours start_time/
// end_time - unlike positionRanges (derivedHourTimeRanges), this never
// falls back to guessing off whichever class happens to have its own
// start/end filled in. That per-class fallback is a reasonable best-effort
// label for a position nobody's set an hour-level time for, but it's the
// wrong source for a FLOATER's actual attendance window: a floater isn't
// tied to any one class, so if one class sharing that hour happens to run
// long (e.g. 10:00-11:30 while the position itself has no hour-level time
// set), every floater assigned to that hour would silently inherit that
// one class's own duration as their own arrival/departure - the same
// "one longer class contaminates a shared position" bug effectiveClassRange
// was built to avoid for real class enrollment, recurring here for
// floaters. Returns null (honestly unknown) rather than guess.
function hourOnlyRange(position, hourByPosition) {
  const hour = hourByPosition[position];
  if (!hour) return null;
  const startMin = parseClockMinutesLocal(hour.start_time);
  if (startMin == null) return null;
  const endMin = parseClockMinutesLocal(hour.end_time);
  return { startMin, endMin };
}

// Whether two { startMin, endMin } ranges overlap at all. Requires a real,
// known endMin on BOTH sides - an unknown end can't be safely compared
// against anything, so this conservatively says "no overlap" rather than
// risk a false positive off a guessed end.
function rangesOverlap(a, b) {
  if (!a || !b || a.endMin == null || b.endMin == null) return false;
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// A live bug report: a member enrolled in (or staffing) a class whose own
// explicit time genuinely runs longer than the single hour_position it's
// filed under (a real "double period" - e.g. a class filed under
// position 1 with its own end_time set to what would normally be
// position 2's end) stayed on the Floater Assignments list for position
// 2 even after being picked up for that class - nothing had ever told the
// floater-removal logic (see removeFromFloaterForHour) that the class's
// own real time reaches into a position it isn't literally filed under.
// Returns every position (the class's own hour_position, plus any other
// position whose own hour-level time the class's effective range
// genuinely overlaps) that a member busy with this class should be
// cleared off the floater list for.
function positionsOverlappingRange(range, hourByPosition) {
  const positions = new Set();
  if (!range) return positions;
  for (const position of HOUR_POSITIONS) {
    if (rangesOverlap(range, hourOnlyRange(position, hourByPosition))) positions.add(position);
  }
  return positions;
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

// Every member's OWN live attendance window for a day (earliest start /
// latest end, in minutes-since-midnight) - deliberately each person's
// own commitments only (their own class enrollment, their own teaching/
// assisting, their own floater hours), never merged with another family
// member's separate schedule. A parent teaching Hour 1 and floating Hour
// 3 gets a window ending at Hour 3's end even if their own kid's own
// class runs later - the kid gets their own, independently-computed
// window ending at their own last class. Computed fresh from current
// class/enrollment/staffing/floater data on every call, never read back
// from the separately-cached member_schedules table - that table only
// gets rebuilt when enrollment/staffing/floater assignments actually
// change, so a member who hasn't been touched since a fix to this
// computation landed would otherwise keep showing whatever was cached
// under the old (buggy) logic. Returns { [memberId]: { start, end } }; a
// member with nothing resolvable on the schedule is simply absent from
// the map. Used by utils/schedule.js's arrivalDepartureLabels. Note this
// is a different (narrower) window than ownPositionsAndFamilyWindowsForDay's
// own windowByFamily, which autoAssignFloatersForDay still deliberately
// uses family-wide, to decide which of a parent's blank hours to
// auto-float even when the parent has no class of their own that day (see
// that function's own comment) - that "am I at the co-op at all today"
// question is a genuinely different one than "what time do I personally
// arrive/depart," which is what this function answers.
async function familyAttendanceWindowsForDay(day) {
  const { ownPositionsByMember, ownRangesByMember, hourByPosition } = await ownPositionsAndFamilyWindowsForDay(day);
  // Snapshot each member's REAL (class/staffing) ranges before the floater
  // loop below adds to the same arrays - needed so the overlap check just
  // below only ever compares a floater hour against a real class, never
  // against another floater section already added earlier in this same
  // loop.
  const realRangesByMember = {};
  Object.entries(ownRangesByMember).forEach(([memberId, ranges]) => { realRangesByMember[memberId] = [...ranges]; });

  const list = await getListByDay(day);
  if (list) {
    for (const section of await sectionsForList(list.id)) {
      // A floater hour isn't tied to any one specific class, so only the
      // hour's OWN saved start/end time counts here (see hourOnlyRange) -
      // never positionRanges' per-class fallback guess, which is fine for
      // a display label but would otherwise silently hand every floater
      // on this hour whichever one class's own duration happened to be
      // set, even though the floater has no real relation to that class.
      const sectionRange = hourOnlyRange(section.position, hourByPosition);
      for (const memberId of await membersForSectionRaw(list.id, section.id)) {
        if (!ownPositionsByMember[memberId]) ownPositionsByMember[memberId] = new Set();
        ownPositionsByMember[memberId].add(section.position);
        if (!sectionRange) continue;
        // A live bug report: a member whose own real class time genuinely
        // overlaps this floater hour (a "double period" filed under a
        // different position - see positionsOverlappingRange's own
        // comment) shouldn't have this hour's range unioned in on top of
        // their real class - addStaff/setEnrollment already clear this
        // exact floater membership going forward, but a member who was
        // already on it before that fix shipped needs the same check
        // here too, so Arrival/Departure self-heals immediately instead
        // of staying wrong until something happens to re-sync their
        // specific class.
        if ((realRangesByMember[memberId] || []).some((r) => rangesOverlap(sectionRange, r))) continue;
        if (!ownRangesByMember[memberId]) ownRangesByMember[memberId] = [];
        ownRangesByMember[memberId].push(sectionRange);
      }
    }
  }

  const result = {};
  Object.keys(ownPositionsByMember).forEach((memberIdStr) => {
    const memberId = Number(memberIdStr);
    let w = null;
    (ownRangesByMember[memberId] || []).forEach((range) => {
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

  // A real bug report: an admin removing someone from a floater hour
  // (routes/admin-volunteers.js's own remove route) wasn't sticking - the
  // very next call to this function, which syncDayMemberRosters always
  // makes on its way to rebuilding the day's rosters, re-derived the same
  // eligibility from scratch and put them right back. excludedPairs is
  // that removal's own memory - see removeMemberFromSection's comment.
  const excludedPairs = await excludedFloaterPairsForList(list.id);

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
      if (excludedPairs.has(`${parentId}-${section.id}`)) continue;
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
  // member_type IN ('parent', 'admin'), not just 'parent' - a real bug
  // report: "admins should still be considered parents everywhere. they
  // aren't being included in the monday/wednesday rosters." A family
  // whose only adult member record is admin-typed (not a separate
  // 'parent' record) has no representative here otherwise, so an admin's
  // enrolled kid never puts them on the day's roster despite being at
  // the co-op that day, same as any other parent would be.
  const allParents = (
    await db
      .prepare(
        `SELECT id, family_id, is_primary_parent, name FROM members
         WHERE active = 1 AND member_type IN ('parent', 'admin') AND family_id IN (${placeholders})`
      )
      .all(...ids)
  ).sort(byLastName);
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
  // 'admin' alongside 'parent' - matches primaryParentIdsByFamily below,
  // which now recognizes an admin as a family's representative too. Keeps
  // an admin on the team from being silently treated as "not a parent
  // record, leave alone" and skipped even when they genuinely are (or
  // aren't) this family's primary.
  const parents = await db
    .prepare(`SELECT id, family_id FROM members WHERE id IN (${placeholders}) AND member_type IN ('parent', 'admin')`)
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
    // class_staff can now hold a student (a teen teaching/assisting a
    // class - see activeMembersForStaff), not just a parent, so which
    // roster each staff member belongs on has to follow their own real
    // member_type instead of assuming everyone here is a parent.
    const staffMemberIds = [
      ...new Set((await db.prepare(`SELECT DISTINCT member_id FROM class_staff WHERE class_id IN (${placeholders})`).all(...classIds)).map((r) => r.member_id)),
    ];
    if (staffMemberIds.length > 0) {
      const staffPlaceholders = staffMemberIds.map(() => '?').join(',');
      (await db.prepare(`SELECT id, member_type FROM members WHERE id IN (${staffPlaceholders})`).all(...staffMemberIds)).forEach((r) => {
        (r.member_type === 'student' ? studentIds : parentIds).add(r.id);
      });
    }
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

// The real, parseable start/end time for each hour POSITION on a day -
// shared/aggregate use only (schedule card time text for a class with
// NEITHER of its own times, and floater-hour matching); a specific
// family's own arrival/departure window uses effectiveClassRange per
// member instead (see ownPositionsAndFamilyWindowsForDay), precisely
// because this function's per-position guess below is not reliable
// enough to represent one specific class or family.
// hours (a day's class_schedule_hours rows, each carrying its own shared
// start_time/end_time - see saveHourLabels) is optional and defaults to
// none, for callers that only have classes on hand. Where the hour itself
// has a real start time, it wins outright as the position's range - a
// real bug report: multiple classes can share one hour position (parallel
// rooms) with genuinely different lengths, and the old "whichever class
// has the earliest start_time wins, use THAT class's own end_time"
// approach let one unusually long class's end time silently become the
// position's shared range for every OTHER, normal-length class sharing
// that hour. Per-class start_time/end_time is now only consulted as a
// fallback for a position with no hour-level time set at all (the same
// live-derivation roomGridForDay does for its own column headers, and for
// the same reason: the separately-stored class_schedule_hours label only
// gets refreshed at import time, so it's easy for it to sit stuck on the
// generic "Hour N" default while classes with real times exist there).
// { [position]: { startMin, endMin, label } } - endMin/label omitted when
// neither the hour nor any class at that position has a parseable
// end_time to pair with a start.
function derivedHourTimeRanges(rawClasses, hours = []) {
  const ranges = {};

  hours.forEach((h) => {
    const hourStart = parseClockMinutesLocal(h.start_time);
    if (hourStart == null) return;
    const hourEnd = parseClockMinutesLocal(h.end_time);
    ranges[h.position] = hourEnd != null
      ? { startMin: hourStart, endMin: hourEnd, label: `${minutesToClockLabelLocal(hourStart)} - ${minutesToClockLabelLocal(hourEnd)}` }
      : { startMin: hourStart, endMin: null, label: minutesToClockLabelLocal(hourStart) };
  });

  const bestByPosition = {};
  rawClasses.forEach((cls) => {
    if (ranges[cls.hour_position]) return; // the hour's own time already wins this position
    const startMinutes = parseClockMinutesLocal(cls.start_time);
    if (startMinutes == null) return;
    const current = bestByPosition[cls.hour_position];
    if (!current || startMinutes < current.startMinutes) {
      bestByPosition[cls.hour_position] = { startMinutes, endTime: cls.end_time };
    }
  });
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
  return ranges;
}

async function rawHourLabel(day, position) {
  const hour = await db.prepare('SELECT label FROM class_schedule_hours WHERE day = ? AND position = ?').get(day, position);
  return (hour && hour.label) || '';
}

// A class's display time range: its own start_time/end_time if an admin
// set them, otherwise falls back per-half to its hour block's own
// start/end (see effectiveClassRange), otherwise its hour block's raw
// stored label (e.g. "Hour 1" or whatever an admin renamed it to via Edit
// Hours). Deliberately never looks at another class sharing the same
// hour_position (a real bug report: a class with no time of its own used
// to borrow whichever sibling class in that hour had the earliest
// start_time, using THAT sibling's own end_time too - see
// effectiveClassRange's own comment on the same fix already made for
// Arrival/Departure and the Schedule Card).
async function timeRangeForClass(cls) {
  if (cls.start_time && cls.end_time) return `${cls.start_time} - ${cls.end_time}`;
  const hour = await db.prepare('SELECT position, start_time, end_time FROM class_schedule_hours WHERE day = ? AND position = ?').get(cls.day, cls.hour_position);
  const range = effectiveClassRange(cls, hour ? { [cls.hour_position]: hour } : {});
  return rangeToLabel(range) || (await rawHourLabel(cls.day, cls.hour_position));
}

// Everyone's live schedule rows for one day - the read-side twin of
// syncMemberSchedulesForDay below, computed fresh from the same source
// data (Class Schedule + Floater Assignments) every call instead of
// reading member_schedules, which only updates when something explicitly
// triggers that function. A real bug report: a member's Schedule Card
// (in every one of its display surfaces - the member profile's Schedule
// popup, admin Schedules > Student/Parent tabs, both print pages, and the
// designed visual card) kept showing a stale End Time after a fix to how
// times are derived landed, because nothing had re-triggered a resync of
// that member specifically. getMemberSchedule/scheduleList (utils/
// schedule.js) now use this instead, so every one of those surfaces is
// always current with no separate "did someone resync" step to go stale.
// A person shows up once per class they're either enrolled in (student)
// or staffing (teacher/assistant); "teacher" on their row lists that
// class's teacher(s), themselves included if that's their own class. A
// floater then fills in any of THEIR hours that aren't already a real
// class slot on their own schedule, labeled "Floater" - matched purely by
// hour position, not to any specific class, so it never overwrites a real
// one. Returns { [memberId]: { [hourPosition]: row } } - a raw
// hourPosition-keyed map, not yet the fixed 4-row array
// getMemberSchedule's own shape needs.
async function liveMemberScheduleRowsForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  const hours = await hoursForDay(day);
  const hourByPosition = {};
  hours.forEach((h) => { hourByPosition[h.position] = h; });
  const rowsByMember = {};
  const rangesByMember = {};

  // A live bug report: this class row's own displayed time (and, below,
  // a floater's) used to fall back to derivedHourTimeLabels - the same
  // per-POSITION "whichever class here has the earliest start_time wins,
  // use THAT class's own end_time" guess effectiveClassRange/hourOnlyRange
  // were built to keep OUT of a real family's own arrival/departure
  // window (see effectiveClassRange's own comment on the original bug
  // report). Arrival/Departure got that fix; this Schedule Card row
  // display quietly kept the old contamination-prone fallback, so a class
  // sharing an hour with a longer one (or a floater on that same hour)
  // could still show the long class's own borrowed time here even after
  // Arrival/Departure was correct. effectiveClassRange only ever draws
  // from the class's OWN start/end or its hour's OWN start/end - never
  // another class's - so this row can no longer be contaminated by a
  // neighbor sharing the same hour position.
  for (const cls of classes) {
    const range = effectiveClassRange(cls, hourByPosition);
    const time = (cls.start_time && cls.end_time)
      ? `${cls.start_time} - ${cls.end_time}`
      : rangeToLabel(range) || (await rawHourLabel(day, cls.hour_position));
    const staff = await staffForClass(cls.id);
    const teacherNames = staff.filter((s) => s.role === 'teacher').map((s) => s.name).join(', ');
    const row = { class_number: cls.hour_position, time, class_name: cls.class_name, room: cls.room || '', teacher: teacherNames };
    const people = [...(await studentsForClass(cls.id)), ...staff];
    for (const person of people) {
      if (!rowsByMember[person.id]) rowsByMember[person.id] = {};
      rowsByMember[person.id][cls.hour_position] = row;
      if (range) {
        if (!rangesByMember[person.id]) rangesByMember[person.id] = [];
        rangesByMember[person.id].push(range);
      }
    }
  }

  const list = await getListByDay(day);
  if (list) {
    // A floater hour isn't tied to any one specific class (see
    // hourOnlyRange's own comment) - only the hour's OWN saved start/end
    // time counts here, never a borrowed guess from whichever class
    // happens to share the position.
    const hourLabels = {};
    hours.forEach((h) => { hourLabels[h.position] = rangeToLabel(hourOnlyRange(h.position, hourByPosition)) || h.label; });
    for (const section of await sectionsForList(list.id)) {
      const sectionRange = hourOnlyRange(section.position, hourByPosition);
      for (const memberId of await membersForSectionRaw(list.id, section.id)) {
        if (!rowsByMember[memberId]) rowsByMember[memberId] = {};
        if (rowsByMember[memberId][section.position]) continue; // a real class slot at this exact position always wins
        // A live bug report: a member whose own class genuinely runs
        // longer than the single hour_position it's filed under (see
        // positionsOverlappingRange's own comment) still showed up as a
        // "Floater" for a position their real class's time actually
        // overlaps, even though they're already busy then - the position
        // just never had a class ROW filed under it specifically.
        if (sectionRange && (rangesByMember[memberId] || []).some((r) => rangesOverlap(sectionRange, r))) continue;
        rowsByMember[memberId][section.position] = {
          class_number: section.position, time: hourLabels[section.position] || '', class_name: 'Floater', room: '', teacher: '',
        };
      }
    }
  }

  return rowsByMember;
}

// member_schedules (a cached snapshot, no longer read from directly - see
// liveMemberScheduleRowsForDay above, which superseded it as the read
// path) is entirely derived from the master Class Schedule and the
// Floater Assignments list - there's no separate hand-typed version
// anymore, so this fully rebuilds one day's rows every time either
// changes (called from syncDayMemberRosters, which already runs on every
// enrollment/staff/class/floater edit). A person shows up once per class
// they're either enrolled in (student) or staffing (teacher/assistant);
// "teacher" on their row lists that class's teacher(s), themselves
// included if that's their own class. A floater then fills in any of
// THEIR hours that aren't already a real class slot on their own
// schedule, labeled "Floater" - matched purely by hour position (the
// Floater Assignments chart's "Hour N" against the class grid's own
// "Hour N", the same position class_schedule_hours already keys both by),
// not to any specific class, so it never overwrites a real one.
//
async function syncMemberSchedulesForDay(day) {
  const classes = await db.prepare('SELECT * FROM classes WHERE day = ?').all(day);
  const hours = await hoursForDay(day);
  const hourByPosition = {};
  hours.forEach((h) => { hourByPosition[h.position] = h; });
  await db.prepare('DELETE FROM member_schedules WHERE day = ?').run(day);
  const upsert = db.prepare(
    `INSERT INTO member_schedules (member_id, day, class_number, time, class_name, room, teacher, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, now_text())
     ON CONFLICT(member_id, day, class_number) DO UPDATE SET
       time = excluded.time, class_name = excluded.class_name, room = excluded.room,
       teacher = excluded.teacher, updated_at = now_text()`
  );

  // Same contamination fix as liveMemberScheduleRowsForDay's own copy of
  // this loop (see that function's comment) - effectiveClassRange/
  // hourOnlyRange, never derivedHourTimeLabels' per-position guess.
  for (const cls of classes) {
    const time = (cls.start_time && cls.end_time)
      ? `${cls.start_time} - ${cls.end_time}`
      : rangeToLabel(effectiveClassRange(cls, hourByPosition)) || (await rawHourLabel(day, cls.hour_position));
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
    hours.forEach((h) => { hourLabels[h.position] = rangeToLabel(hourOnlyRange(h.position, hourByPosition)) || h.label; });
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
  UNASSIGNED_ROOM,
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
  floaterPositionsCoveredByClass,
  autoAssignFloatersForDay,
  removeNonPrimaryParentsFromFloaterTeams,
  familyAttendanceWindowsForDay,
  minutesToClockLabelLocal,
  removeStaff,
  activeStudents,
  activeMembersForStaff,
  staffListForDay,
  classesNeedingStaffForDay,
  classesAtRiskForDay,
  absentMemberIdsForDate,
  checkedInMemberIdsForDate,
  absenceFormMemberIdsForDate,
  absenceFormAbsentMemberIdsForDate,
  missingMemberIdsForDate,
  appSetting,
  setAppSetting,
  ensureClassRoster,
  syncClassRosterMembers,
  classRosterIdsForDay,
  backfillClassRosterDates,
  ensureDayRoster,
  ensureDayMemberRosters,
  syncDayMemberRosters,
  syncMemberSchedulesForDay,
  liveMemberScheduleRowsForDay,
  addManualRosterMember,
  allClassesList,
};

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { requireDay, isValidDay, parseDayValue } = require('../utils/days');
const { ageFromBirthday } = require('../utils/dates');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const {
  DAY_LABELS,
  HOUR_POSITIONS,
  COLOR_PALETTE,
  GRADE_LEVELS,
  ageGroupList,
  defaultDay,
  hoursForDay,
  saveHourLabels,
  syncMemberSchedulesForDay,
  syncDayMemberRosters,
  gridForDay,
  roomGridForDay,
  renameRoom,
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
  removeStaff,
  activeStudents,
  activeMembersForStaff,
} = require('../utils/classSchedule');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

router.get('/class-schedule', requireAdmin, (req, res) => res.redirect(`/admin/class-schedule/${defaultDay()}`));

// Registered before the /:day route below - otherwise Express's param
// route would swallow this exact-path request too (":day" matches any
// single path segment, including "import-template.xlsx").
router.get('/class-schedule/import-template.xlsx', requireFullAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(
    [
      'Day', 'Hour', 'Class Name', 'Room', 'Grade',
      'Class Start Time', 'Class End Time', 'Class Description',
      'Teacher', '2nd Teacher', 'Assistant 1', 'Assistant 2', 'Assistant 3',
    ],
    [
      ['Monday', '1', 'Art Adventures', 'Room 3', '1st', '9:00 AM', '9:45 AM', 'Painting and drawing projects', 'Jane Smith', '', 'John Doe', '', ''],
      ['Monday', '2', 'Middle School Science', 'Room 8', '6th', '10:00 AM', '10:45 AM', '', 'Pat Rivera', '', '', '', ''],
      ['Wednesday', '1', 'PE', 'Gym', '', '', '', '', '', '', '', '', ''],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="class-schedule-import-template.xlsx"');
  res.send(buffer);
});

// This used to be its own standalone page (views/admin-class-schedule.ejs,
// now deleted) - a second, near-identical rendering of the exact same day
// grid partials/class-schedule-grid.ejs shows on the *real* Class
// Schedules tab (/admin/schedule?tab=monday|wednesday, routes/
// admin-schedule.js), minus that page's Class/Student/Parent Schedules
// tab bar and its Monday/Wednesday pill toggle - just a bare Day
// <select>. Nothing ever linked to this route directly, but every
// create/edit/delete/import action elsewhere in this file redirects back
// to it (`/admin/class-schedule/${day}...`), which meant every single one
// of those actions bounced the admin onto the tab-less, toggle-less
// duplicate page instead of back to where they started. Simplest fix:
// keep this route as the thing every one of those redirects already
// targets (so none of them need to change), but have it immediately
// redirect again to the real tabbed page - carrying every existing query
// param (date/error/notice) through unchanged.
router.get('/class-schedule/:day', requireAdmin, requireDay, (req, res) => {
  const params = new URLSearchParams(req.query);
  params.set('tab', req.params.day);
  res.redirect(`/admin/schedule?${params.toString()}`);
});

// Single "Edit" dialog covers both hour labels and room renames in one
// Save, instead of two separate toolbar buttons/dialogs/routes.
router.post('/class-schedule/:day/edit', requireFullAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const labels = [].concat(req.body.labels || []);
  const startTimes = [].concat(req.body.startTimes || []);
  const endTimes = [].concat(req.body.endTimes || []);
  await saveHourLabels(day, labels, startTimes, endTimes);

  const oldNames = [].concat(req.body.oldNames || []);
  const newNames = [].concat(req.body.newNames || []);
  let renamed = 0;
  for (let i = 0; i < oldNames.length; i++) {
    const oldName = oldNames[i];
    const newName = (newNames[i] || '').trim();
    if (newName && newName !== oldName) {
      await renameRoom(day, oldName, newName);
      renamed++;
    }
  }

  // Every schedule row (class or floater) that falls back to the hour's
  // shared label for its displayed time, or carries a class's room, needs
  // to pick up both the hour-label and room renames above - run last so it
  // reads the already-renamed rooms, not the stale pre-rename ones.
  await syncMemberSchedulesForDay(day);

  res.redirect(
    `/admin/class-schedule/${day}?notice=` +
      encodeURIComponent(`Hours updated${renamed ? ` and ${renamed} room(s) renamed` : ''}.`)
  );
});

// Saves a custom drag-reordered room row order for the grid - see
// getRoomOrder/saveRoomOrder in utils/classSchedule.js. Called via fetch
// from public/js/room-row-reorder.js right after a drag ends, not a full
// form submit, so reordering stays a single smooth interaction instead of
// a page reload.
router.post('/class-schedule/:day/rooms/reorder', requireFullAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const rooms = [].concat(req.body.rooms || []).map((r) => String(r));
  await saveRoomOrder(day, rooms);
  res.json({ ok: true });
});

// Day-agnostic: the Create New Class form itself has a Class Day field
// (matching the reference design) rather than being locked to whichever
// day page the dialog was opened from, so this reads day from the body
// instead of a route param. Falls back to the day-scoped page on error so
// the admin lands back where they started.
router.post('/class-schedule/classes/new', requireFullAdmin, async (req, res) => {
  const day = isValidDay(req.body.day) ? req.body.day : null;
  const className = (req.body.className || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (!day || !className || !HOUR_POSITIONS.includes(hourPosition)) {
    return res.redirect(`/admin/class-schedule/${day || 'monday'}?error=` + encodeURIComponent('Class day, name, and hour are required.'));
  }
  const id = await createClass({
    day,
    hourPosition,
    className,
    room: (req.body.room || '').trim(),
    ageGroup: [].concat(req.body.ageGroup || []).join(', '),
    color: req.body.color || null,
    notes: (req.body.notes || '').trim(),
    startTime: (req.body.startTime || '').trim(),
    endTime: (req.body.endTime || '').trim(),
  });

  const teacherId = parseInt(req.body.teacherId, 10);
  if (teacherId) await addStaff(id, teacherId, 'teacher');
  const assistantIds = [].concat(req.body.assistantIds || [])
    .map((v) => parseInt(v, 10))
    .filter(Boolean);
  for (const assistantId of assistantIds) await addStaff(id, assistantId, 'assistant');

  // Land back on the day's schedule grid (where the dialog was opened
  // from) instead of jumping to the class's own Manage page - the dialog
  // just closes and the newly created class shows up on the grid.
  res.redirect(`/admin/class-schedule/${day}?notice=` + encodeURIComponent(`"${className}" created.`));
});

// Powers the "View" button's dialog on the day grid - fetched as an HTML
// fragment (no <html>/<body>) and injected into a shared dialog, so
// viewing/editing a class never leaves the grid page. Starts view-only;
// the fragment's own "Edit Class" button unlocks the form client-side.
router.get('/class-schedule/classes/:id/view-fragment', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const enrolledIds = cls.students.map((s) => s.id);
  const staffIds = cls.staff.map((s) => s.id);

  res.render('class-schedule-view-fragment', {
    cls,
    hours: await hoursForDay(cls.day),
    gradeLevels: GRADE_LEVELS,
    colorPalette: COLOR_PALETTE,
    selectedGrades: ageGroupList(cls.age_group),
    availableStudents: (await activeStudents()).filter((s) => !enrolledIds.includes(s.id)),
    enrolledStudents: cls.students.map((s) => ({ ...s, age: ageFromBirthday(s.birthday) })),
    availableStaff: (await activeMembersForStaff()).filter((p) => !staffIds.includes(p.id)),
  });
});

// Kept as a standalone page too (direct-link/bookmark friendly), even
// though the grid's "View" button now opens the same content as a popup.
router.get('/class-schedule/classes/:id/manage', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const enrolledIds = cls.students.map((s) => s.id);
  const staffIds = cls.staff.map((s) => s.id);

  res.render('admin-class-schedule-manage', {
    title: `Manage - ${cls.class_name}`,
    cls,
    dayLabel: DAY_LABELS[cls.day],
    hours: await hoursForDay(cls.day),
    gradeLevels: GRADE_LEVELS,
    colorPalette: COLOR_PALETTE,
    selectedGrades: ageGroupList(cls.age_group),
    availableStudents: (await activeStudents()).filter((s) => !enrolledIds.includes(s.id)),
    enrolledStudents: cls.students.map((s) => ({ ...s, age: ageFromBirthday(s.birthday) })),
    availableStaff: (await activeMembersForStaff()).filter((p) => !staffIds.includes(p.id)),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/class-schedule/classes/:id', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const className = (req.body.className || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (!className || !HOUR_POSITIONS.includes(hourPosition)) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent('Class name and hour are required.'));
  }

  await updateClass(id, {
    day: cls.day,
    hourPosition,
    className,
    room: (req.body.room || '').trim(),
    ageGroup: [].concat(req.body.ageGroup || []).join(', '),
    color: req.body.color || cls.color,
    notes: (req.body.notes || '').trim(),
    startTime: (req.body.startTime || '').trim(),
    endTime: (req.body.endTime || '').trim(),
  });
  res.redirect(`/admin/class-schedule/${cls.day}?notice=` + encodeURIComponent(`"${className}" updated.`));
});

router.post('/class-schedule/classes/:id/delete', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  await deleteClass(id);
  res.redirect(`/admin/class-schedule/${cls.day}?notice=` + encodeURIComponent(`Deleted "${cls.class_name}".`));
});

// Archives the checked classes (checkboxes on the day's own grid, or its
// "Select All") - e.g. clearing a day before re-running Import Classes
// on a corrected file, without losing the record of what was there.
// Moves them out of the live schedule and into the Class Archive tab -
// see archiveClasses' own comment.
router.post('/class-schedule/:day/archive', requireFullAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const classIds = [].concat(req.body.classIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (classIds.length === 0) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Select at least one class to archive.'));
  }
  const count = await archiveClasses(classIds);
  res.redirect(`/admin/class-schedule/${day}?notice=` + encodeURIComponent(`Archived ${count} class(es) - see the Class Archive tab.`));
});

router.get('/class-schedule/archive/export.csv', requireFullAdmin, async (req, res) => {
  const archives = await listClassArchives();
  const lines = [
    toCsvRow(['Day', 'Class Name', 'Room', 'Grade', 'Start Time', 'End Time', 'Teachers', 'Assistants', 'Students', 'Notes', 'Archived At']),
    ...archives.map((a) =>
      toCsvRow([
        DAY_LABELS[a.day] || a.day,
        a.class_name,
        a.room || '',
        a.age_group || '',
        a.start_time || '',
        a.end_time || '',
        a.teachers || '',
        a.assistants || '',
        a.student_count,
        a.notes || '',
        a.archived_at,
      ])
    ),
  ];
  sendCsv(res, 'class-schedule-archive.csv', lines);
});

router.post('/class-schedule/archive/:id/delete', requireFullAdmin, async (req, res) => {
  await deleteClassArchive(parseInt(req.params.id, 10));
  res.redirect('/admin/schedule?tab=archive&notice=' + encodeURIComponent('Deleted from archive.'));
});

router.post('/class-schedule/archive/delete-all', requireFullAdmin, async (req, res) => {
  const count = await deleteAllClassArchives();
  res.redirect('/admin/schedule?tab=archive&notice=' + encodeURIComponent(`Deleted all ${count} archived class(es).`));
});

// A real bug report: "when adding or deleting new members on edit class
// popup it goes to an error page." Every one of these 4 routes called
// straight into setEnrollment/addStaff/removeStaff with no try/catch, so
// any failure there (a genuinely bad row, a transient DB error, anything)
// fell through to server.js's generic catch-all and rendered the same
// blank "Something went wrong" page every other unguarded upload/mutation
// route used to (see routes/admin-documents.js's own identical fix) -
// no way for the admin to tell what happened or for it to get reported
// back accurately. Wrapping each in try/catch surfaces the real
// underlying message via the existing error-banner redirect instead.
router.post('/class-schedule/classes/:id/enrollment/add', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const addIds = [].concat(req.body.studentIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const existingIds = cls.students.map((s) => s.id);
  try {
    await setEnrollment(id, [...new Set([...existingIds, ...addIds])]);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent(`Could not update roster: ${err.message}`));
  }
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/enrollment/:studentId/remove', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const studentId = parseInt(req.params.studentId, 10);
  try {
    await setEnrollment(id, cls.students.map((s) => s.id).filter((sid) => sid !== studentId));
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent(`Could not update roster: ${err.message}`));
  }
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/add', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const memberId = parseInt(req.body.memberId, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  try {
    if (memberId) await addStaff(id, memberId, role);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent(`Could not update roster: ${err.message}`));
  }
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/:memberId/remove', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  try {
    await removeStaff(id, parseInt(req.params.memberId, 10));
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent(`Could not update roster: ${err.message}`));
  }
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

// Combined "+ Add Member" dialog on the View popup's roster - one form,
// role picks whether it enrolls a student or staffs a teacher/assistant.
// Also reachable via fetch() from the class-view-dialog popup itself
// (public/js/class-schedule-view.js) - adding a roster member is
// something an admin does repeatedly in a row while building out a
// class, so that JS submits with Accept: application/json and refreshes
// the popup's own content in place afterward instead of following a
// redirect, which would otherwise bounce back to the bare grid and close
// the popup on every single add. A plain (non-fetch) form submission
// still gets the original redirect - no JS, no problem.
router.post('/class-schedule/classes/:id/roster/add', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  try {
    const role = req.body.role;
    if (role === 'student') {
      const studentId = parseInt(req.body.studentId, 10);
      if (studentId) {
        const existingIds = cls.students.map((s) => s.id);
        if (!existingIds.includes(studentId)) await setEnrollment(id, [...existingIds, studentId]);
      }
    } else if (role === 'teacher' || role === 'assistant') {
      const staffId = parseInt(req.body.staffId, 10);
      if (staffId) await addStaff(id, staffId, role);
    }
  } catch (err) {
    // A real bug report: "when adding or deleting new members on edit
    // class popup it goes to an error page." public/js/class-schedule-
    // view.js's fetch()-based Add Member handler falls back to a real
    // form.submit() on ANY non-ok response - before this, that resubmit
    // hit this exact same unguarded code a second time and crashed into
    // server.js's generic catch-all either way, so the fallback never
    // actually helped. Returning a real error here for both paths (JSON
    // for the fetch case, a redirect with the existing error banner for
    // the plain-form fallback) means a genuine failure now surfaces the
    // real reason instead of a blank "Something went wrong" no matter
    // which path handles it.
    if (wantsJson) return res.status(500).json({ ok: false, error: err.message });
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent(`Could not add member: ${err.message}`));
  }
  if (wantsJson) return res.json({ ok: true });
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.get('/class-schedule/classes/:id/roster/export.csv', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const lines = [toCsvRow(['Name', 'Role', 'Family', 'Age', 'Grade Level', 'Birthday', 'Medical Notes'])];
  cls.staff.forEach((s) => lines.push(toCsvRow([s.name, s.role === 'assistant' ? 'Assistant' : 'Teacher', '', '', '', '', ''])));
  cls.students.forEach((s) =>
    lines.push(
      toCsvRow([
        s.name,
        'Student',
        s.family_name || '',
        ageFromBirthday(s.birthday) ?? '',
        s.grade_level || '',
        s.birthday || '',
        s.medical_notes || '',
      ])
    )
  );

  sendCsv(res, `${cls.class_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-roster.csv`, lines);
});

router.get('/class-schedule/classes/:id/roster/print', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  res.render('class-schedule-roster-print', {
    title: `${cls.class_name} Roster`,
    cls: { ...cls, students: cls.students.map((s) => ({ ...s, age: ageFromBirthday(s.birthday) })) },
    dayLabel: DAY_LABELS[cls.day],
  });
});

router.get('/class-schedule/classes/:id/roster/import-template.xlsx', requireFullAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(['Student First Name', 'Student Last Name'], [['Jane', 'Smith'], ['John', 'Smith']]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="class-roster-import-template.xlsx"');
  res.send(buffer);
});

router.post('/class-schedule/classes/:id/roster/import', requireFullAdmin, upload.single('file'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  if (!req.file) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = await readRowsFromFile(req.file.buffer);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  const names = rows
    .map((r) => {
      const lowerMap = {};
      for (const key of Object.keys(r)) lowerMap[key.trim().toLowerCase()] = r[key];
      const first = lowerMap['student first name'] !== undefined ? String(lowerMap['student first name']).trim() : '';
      const last = lowerMap['student last name'] !== undefined ? String(lowerMap['student last name']).trim() : '';
      return [first, last].filter(Boolean).join(' ');
    })
    .filter(Boolean);

  const existingIds = cls.students.map((s) => s.id);
  const addIds = [];
  let skipped = 0;
  for (const name of names) {
    const student = await db.prepare("SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND member_type = 'student' AND active = 1").get(name);
    if (student && !existingIds.includes(student.id) && !addIds.includes(student.id)) addIds.push(student.id);
    else if (!student) skipped++;
  }
  if (addIds.length > 0) await setEnrollment(id, [...existingIds, ...addIds]);

  res.redirect(
    `/admin/class-schedule/${cls.day}?notice=` +
      encodeURIComponent(`Added ${addIds.length} student(s) to "${cls.class_name}"` + (skipped ? `, ${skipped} name(s) not found.` : '.'))
  );
});

const IMPORT_ALIASES = {
  day: ['day'],
  hour: ['hour', 'hour block', 'hour #', 'period'],
  className: ['class name', 'class', 'subject'],
  room: ['room'],
  ageGroup: ['grade', 'grades', 'age group', 'ages', 'age range'],
  startTime: ['class start time', 'start time'],
  endTime: ['class end time', 'end time'],
  description: ['class description', 'description', 'notes'],
  teacher: ['teacher'],
  teacher2: ['2nd teacher'],
  assistant1: ['assistant 1', 'assistant'],
  assistant2: ['assistant 2'],
  assistant3: ['assistant 3'],
};

function normalizeImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const out = {};
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] !== undefined && String(lowerMap[alias]).trim() !== '') {
        out[field] = String(lowerMap[alias]).trim();
        break;
      }
    }
  }
  return out;
}

function parseExplicitHour(value) {
  const n = parseInt(value, 10);
  return HOUR_POSITIONS.includes(n) ? n : null;
}

// "10:45 AM" -> minutes since midnight, for sorting distinct Start Times
// chronologically (buildAutoHourPositions below) - null if unparseable.
// Tolerates an optional ":SS" seconds component (discarded) - see
// utils/schedule.js's copy of this same regex for why: a spreadsheet cell
// formatted as Excel's h:mm:ss AM/PM reads back as "10:00:00 AM" once
// utils/spreadsheetWorker.js uses formatted text instead of a raw serial,
// and that's a real, common time format, not an edge case to reject.
function parseClockMinutes(value) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\s*$/.exec(String(value || ''));
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const suffix = m[3] ? m[3].toLowerCase() : null;
  if (suffix === 'pm' && hour !== 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

// Hour is meant to be optional: a real external schedule export usually
// has no "which of the day's 4 slots" concept at all - its own "Hour"
// column (if it has one at all) just holds the class's actual clock
// time, same as this app's own Class Start Time column. Whichever of the
// two actually parses as a clock time is the row's effective start time,
// used both for auto-slotting below and (when Class Start Time itself is
// blank) as the value that lands on the new class's own start_time.
function effectiveStartTime(r) {
  return r.startTime || (parseClockMinutes(r.hour) != null ? r.hour : '');
}

// For every row that didn't give an explicit, valid 1-4 Hour, every
// distinct effective start time seen for its day is sorted
// chronologically and slotted into positions 1-4 in order - the same
// fixed 4-slots-per-day model every class already has to fit into, just
// derived instead of manually specified. A 5th+ distinct time in one day
// has nowhere to go and is left unassigned (skipped, same as any other
// unmatched row).
function buildAutoHourPositions(rows) {
  const timesByDay = {};
  for (const r of rows) {
    if (!r.resolvedDay || parseExplicitHour(r.hour) != null) continue;
    const minutes = parseClockMinutes(effectiveStartTime(r));
    if (minutes == null) continue;
    if (!timesByDay[r.resolvedDay]) timesByDay[r.resolvedDay] = new Set();
    timesByDay[r.resolvedDay].add(minutes);
  }
  const positions = {};
  for (const [day, minuteSet] of Object.entries(timesByDay)) {
    positions[day] = {};
    [...minuteSet].sort((a, b) => a - b).forEach((minutes, i) => {
      if (i < HOUR_POSITIONS.length) positions[day][minutes] = HOUR_POSITIONS[i];
    });
  }
  return positions;
}

router.post('/class-schedule/:day/import', requireFullAdmin, requireDay, upload.single('file'), async (req, res) => {
  const day = req.params.day;
  if (!req.file) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeImportRow).filter((r) => r.className);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }
  // Day tolerates "Mon"/"Wed" abbreviations, not just the full word (see
  // utils/days.js's parseDayValue) - falls back to whichever day tab
  // Import was clicked from when the column's blank.
  rows.forEach((r) => { r.resolvedDay = r.day ? parseDayValue(r.day) : day; });
  const autoHourPositions = buildAutoHourPositions(rows);

  // Looked up once instead of once per staff name per row - a real import
  // can name the same handful of parents/student teachers across dozens
  // of rows, and each lookup is otherwise a separate round trip to a
  // remote Supabase/Postgres connection (unlike the old single local
  // SQLite file, network latency on every one of those adds up fast on a
  // large file). Parents, admins, AND students, matching
  // activeMembersForStaff's own "a teen can teach/assist too, and admins
  // are still parents/leaders for this purpose too" scope for the picker.
  const activeStaffByName = new Map(
    (await db.prepare("SELECT id, name FROM members WHERE member_type IN ('parent', 'admin', 'student') AND active = 1").all()).map((p) => [p.name.toLowerCase(), p.id])
  );

  let created = 0;
  let skipped = 0;
  let staffNotFound = 0;
  const touchedDays = new Set();
  for (const r of rows) {
    const rowDay = r.resolvedDay;
    if (!rowDay) { skipped++; continue; }
    const rowStartTime = effectiveStartTime(r);
    const hourPosition = parseExplicitHour(r.hour) ?? (autoHourPositions[rowDay] || {})[parseClockMinutes(rowStartTime)];
    if (!hourPosition) { skipped++; continue; }
    const classId = await createClass({
      day: rowDay,
      hourPosition,
      className: r.className,
      room: r.room,
      ageGroup: r.ageGroup,
      // A same-day/room/name/grade class already imported earlier in this
      // file (a different hour block of what's really one multi-hour
      // class) reuses that class's own color instead of an independently
      // cycled one, so roomGridForDay's adjacent-cell merge (which
      // requires matching color and grade, not just matching name) actually
      // spans them into one cell - see colorForClassName's own comment.
      color: await colorForClassName(rowDay, r.room, r.className, r.ageGroup),
      startTime: rowStartTime,
      endTime: r.endTime,
      notes: r.description,
    });
    created++;
    touchedDays.add(rowDay);

    // Teacher + 2nd Teacher + up to 3 Assistants are optional columns - a
    // blank cell just means "no one assigned yet", not a skipped row.
    // Matched against active parents or students by exact (case-
    // insensitive) name, same lookup the roster import above already uses
    // for students. class_staff allows any number of 'teacher'-role rows
    // per class, so a 2nd Teacher is staffed exactly the same way as the
    // first.
    const staffToAdd = [
      { name: r.teacher, role: 'teacher' },
      { name: r.teacher2, role: 'teacher' },
      { name: r.assistant1, role: 'assistant' },
      { name: r.assistant2, role: 'assistant' },
      { name: r.assistant3, role: 'assistant' },
    ].filter((s) => s.name);
    for (const s of staffToAdd) {
      const staffId = activeStaffByName.get(s.name.toLowerCase());
      // skipSync: true - addStaff's default behavior rebuilds the whole
      // day's rosters/schedules from scratch on every call, which is fine
      // for the one-at-a-time admin picker but far too slow to run once
      // per staff member across a whole file (a large import was timing
      // out against a remote Supabase connection because of exactly this -
      // dozens to hundreds of full-day rebuilds instead of one). Synced
      // once per touched day after the loop below instead.
      if (staffId) await addStaff(classId, staffId, s.role, { skipSync: true });
      else staffNotFound++;
    }
  }

  // The grid's own Hour 1-4 column headers are derived live from actual
  // class data on every render (see roomGridForDay in
  // utils/classSchedule.js), not written here - a real bug report: an
  // earlier version of this route wrote a computed label into the stored
  // class_schedule_hours row (based only on this one file's own rows), and
  // that write never got undone or recomputed once its triggering class
  // was later deleted or corrected, leaving a permanently stuck wrong
  // label ("classes not lining up" persisting even after the bad data was
  // fixed). Rely on the live derivation instead of writing anything here.
  for (const d of touchedDays) await syncDayMemberRosters(d);

  res.redirect(
    `/admin/class-schedule/${day}?notice=` +
      encodeURIComponent(
        `Imported ${created} class(es)` +
          (skipped ? `, ${skipped} row(s) skipped.` : '.') +
          (staffNotFound ? ` ${staffNotFound} teacher/assistant name(s) not found.` : '')
      )
  );
});

router.get('/class-schedule/:day/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const grid = await gridForDay(day);

  const lines = [toCsvRow(['Hour', 'Class Name', 'Room', 'Age Group', 'Students', 'Teachers', 'Assistants'])];
  grid.forEach((hour) => {
    hour.classes.forEach((cls) => {
      const teachers = cls.staff.filter((s) => s.role === 'teacher').map((s) => s.name).join('; ');
      const assistants = cls.staff.filter((s) => s.role === 'assistant').map((s) => s.name).join('; ');
      lines.push(toCsvRow([hour.label, cls.class_name, cls.room || '', cls.age_group || '', cls.students.length, teachers, assistants]));
    });
  });

  sendCsv(res, `${day}-class-schedule.csv`, lines);
});

router.get('/class-schedule/:day/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  res.render('admin-class-schedule-print', {
    title: `${DAY_LABELS[day]} Schedule`,
    dayLabel: DAY_LABELS[day],
    // Room-by-hour grid (same shape the on-screen grid uses) - not the
    // hour-only gridForDay - so the printout keeps room number as its own
    // grid column instead of just a line of text inside each card.
    roomGrid: await roomGridForDay(day),
  });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { requireDay, isValidDay } = require('../utils/days');
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
  gridForDay,
  roomGridForDay,
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
} = require('../utils/classSchedule');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

router.get('/class-schedule', requireAdmin, (req, res) => res.redirect(`/admin/class-schedule/${defaultDay()}`));

// Registered before the /:day route below - otherwise Express's param
// route would swallow this exact-path request too (":day" matches any
// single path segment, including "import-template.xlsx").
router.get('/class-schedule/import-template.xlsx', requireFullAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Day', 'Hour', 'Class Name', 'Room', 'Age Group', 'Teacher', 'Assistant 1', 'Assistant 2', 'Assistant 3'],
    [
      ['Monday', '1', 'Art Adventures', 'Room 3', 'Ages 5-7', 'Jane Smith', 'John Doe', '', ''],
      ['Monday', '2', 'Middle School Science', 'Room 8', 'Ages 11-13', 'Pat Rivera', '', '', ''],
      ['Wednesday', '1', 'PE', 'Gym', 'All Ages', '', '', '', ''],
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
  await saveHourLabels(day, labels);
  // Every schedule row (class or floater) that falls back to the hour's
  // shared label for its displayed time needs to pick up the rename.
  await syncMemberSchedulesForDay(day);

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

  res.redirect(
    `/admin/class-schedule/${day}?notice=` +
      encodeURIComponent(`Hours updated${renamed ? ` and ${renamed} room(s) renamed` : ''}.`)
  );
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
    availableStaff: (await activeParentsForStaff()).filter((p) => !staffIds.includes(p.id)),
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
    availableStaff: (await activeParentsForStaff()).filter((p) => !staffIds.includes(p.id)),
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

router.post('/class-schedule/classes/:id/enrollment/add', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const addIds = [].concat(req.body.studentIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const existingIds = cls.students.map((s) => s.id);
  await setEnrollment(id, [...new Set([...existingIds, ...addIds])]);
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/enrollment/:studentId/remove', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const studentId = parseInt(req.params.studentId, 10);
  await setEnrollment(id, cls.students.map((s) => s.id).filter((sid) => sid !== studentId));
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/add', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const memberId = parseInt(req.body.memberId, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  if (memberId) await addStaff(id, memberId, role);
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/:memberId/remove', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = await getClass(id);
  if (!cls) return res.status(404).send('Not found');
  await removeStaff(id, parseInt(req.params.memberId, 10));
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
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
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
  const buffer = buildTemplateWorkbook(['Student Name'], [['Jane Smith'], ['John Smith']]);
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
      const key = Object.keys(r).find((k) => k.trim().toLowerCase() === 'student name' || k.trim().toLowerCase() === 'name');
      return key ? String(r[key]).trim() : '';
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
  ageGroup: ['age group', 'ages', 'age range'],
  teacher: ['teacher'],
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

router.post('/class-schedule/:day/import', requireFullAdmin, requireDay, upload.single('file'), async (req, res) => {
  const day = req.params.day;
  if (!req.file) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeImportRow).filter((r) => r.className && r.hour);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  let created = 0;
  let skipped = 0;
  let staffNotFound = 0;
  for (const r of rows) {
    const rowDay = (r.day || day).toLowerCase();
    if (rowDay !== 'monday' && rowDay !== 'wednesday') { skipped++; continue; }
    const hourPosition = parseInt(r.hour, 10);
    if (!HOUR_POSITIONS.includes(hourPosition)) { skipped++; continue; }
    const classId = await createClass({ day: rowDay, hourPosition, className: r.className, room: r.room, ageGroup: r.ageGroup });
    created++;

    // Teacher + up to 3 Assistants are optional columns - a blank cell
    // just means "no one assigned yet", not a skipped row. Matched against
    // active parents by exact (case-insensitive) name, same lookup the
    // roster import above already uses for students.
    const staffToAdd = [
      { name: r.teacher, role: 'teacher' },
      { name: r.assistant1, role: 'assistant' },
      { name: r.assistant2, role: 'assistant' },
      { name: r.assistant3, role: 'assistant' },
    ].filter((s) => s.name);
    for (const s of staffToAdd) {
      const parent = await db.prepare("SELECT id FROM members WHERE LOWER(name) = LOWER(?) AND member_type = 'parent' AND active = 1").get(s.name);
      if (parent) await addStaff(classId, parent.id, s.role);
      else staffNotFound++;
    }
  }

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
    title: `${DAY_LABELS[day]} Class Schedule`,
    dayLabel: DAY_LABELS[day],
    // Room-by-hour grid (same shape the on-screen grid uses) - not the
    // hour-only gridForDay - so the printout keeps room number as its own
    // grid column instead of just a line of text inside each card.
    roomGrid: await roomGridForDay(day),
  });
});

module.exports = router;

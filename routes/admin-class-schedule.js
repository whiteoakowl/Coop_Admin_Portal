const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { requireDay, isValidDay } = require('../utils/days');
const { isValidISODate, todayISO, weekdayOf, ageFromBirthday } = require('../utils/dates');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const {
  DAY_LABELS,
  HOUR_POSITIONS,
  COLOR_PALETTE,
  GRADE_LEVELS,
  ageGroupList,
  defaultDay,
  hoursForDay,
  saveHourLabels,
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
  absentMemberIdsForDate,
} = require('../utils/classSchedule');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

// Only defaults the date picker to today when today actually falls on the
// tab's day - otherwise there's nothing meaningful to highlight yet.
function defaultDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : '';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

router.get('/class-schedule', requireAdmin, (req, res) => res.redirect(`/admin/class-schedule/${defaultDay()}`));

// Registered before the /:day route below - otherwise Express's param
// route would swallow this exact-path request too (":day" matches any
// single path segment, including "import-template.xlsx").
router.get('/class-schedule/import-template.xlsx', requireFullAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Day', 'Hour', 'Class Name', 'Room', 'Age Group'],
    [
      ['Monday', '1', 'Art Adventures', 'Room 3', 'Ages 5-7'],
      ['Monday', '2', 'Middle School Science', 'Room 8', 'Ages 11-13'],
      ['Wednesday', '1', 'PE', 'Gym', 'All Ages'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="class-schedule-import-template.xlsx"');
  res.send(buffer);
});

router.get('/class-schedule/:day', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateFor(day);
  res.render('admin-class-schedule', {
    title: 'Class Schedule',
    day,
    dayLabel: DAY_LABELS[day],
    hours: hoursForDay(day),
    roomGrid: roomGridForDay(day),
    rooms: roomsForDay(day),
    gradeLevels: GRADE_LEVELS,
    colorPalette: COLOR_PALETTE,
    availableStaff: activeParentsForStaff(),
    selectedDate,
    absentIds: absentMemberIdsForDate(selectedDate),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Single "Edit" dialog covers both hour labels and room renames in one
// Save, instead of two separate toolbar buttons/dialogs/routes.
router.post('/class-schedule/:day/edit', requireFullAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const labels = [].concat(req.body.labels || []);
  saveHourLabels(day, labels);

  const oldNames = [].concat(req.body.oldNames || []);
  const newNames = [].concat(req.body.newNames || []);
  let renamed = 0;
  oldNames.forEach((oldName, i) => {
    const newName = (newNames[i] || '').trim();
    if (newName && newName !== oldName) {
      renameRoom(day, oldName, newName);
      renamed++;
    }
  });

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
router.post('/class-schedule/classes/new', requireFullAdmin, (req, res) => {
  const day = isValidDay(req.body.day) ? req.body.day : null;
  const className = (req.body.className || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (!day || !className || !HOUR_POSITIONS.includes(hourPosition)) {
    return res.redirect(`/admin/class-schedule/${day || 'monday'}?error=` + encodeURIComponent('Class day, name, and hour are required.'));
  }
  const id = createClass({
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
  if (teacherId) addStaff(id, teacherId, 'teacher');
  [].concat(req.body.assistantIds || [])
    .map((v) => parseInt(v, 10))
    .filter(Boolean)
    .forEach((assistantId) => addStaff(id, assistantId, 'assistant'));

  // Land back on the day's schedule grid (where the dialog was opened
  // from) instead of jumping to the class's own Manage page - the dialog
  // just closes and the newly created class shows up on the grid.
  res.redirect(`/admin/class-schedule/${day}?notice=` + encodeURIComponent(`"${className}" created.`));
});

// Powers the "View" button's dialog on the day grid - fetched as an HTML
// fragment (no <html>/<body>) and injected into a shared dialog, so
// viewing/editing a class never leaves the grid page. Starts view-only;
// the fragment's own "Edit Class" button unlocks the form client-side.
router.get('/class-schedule/classes/:id/view-fragment', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const enrolledIds = cls.students.map((s) => s.id);
  const staffIds = cls.staff.map((s) => s.id);

  res.render('class-schedule-view-fragment', {
    cls,
    hours: hoursForDay(cls.day),
    gradeLevels: GRADE_LEVELS,
    colorPalette: COLOR_PALETTE,
    selectedGrades: ageGroupList(cls.age_group),
    availableStudents: activeStudents().filter((s) => !enrolledIds.includes(s.id)),
    enrolledStudents: cls.students.map((s) => ({ ...s, age: ageFromBirthday(s.birthday) })),
    availableStaff: activeParentsForStaff().filter((p) => !staffIds.includes(p.id)),
  });
});

// Kept as a standalone page too (direct-link/bookmark friendly), even
// though the grid's "View" button now opens the same content as a popup.
router.get('/class-schedule/classes/:id/manage', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const enrolledIds = cls.students.map((s) => s.id);
  const staffIds = cls.staff.map((s) => s.id);

  res.render('admin-class-schedule-manage', {
    title: `Manage - ${cls.class_name}`,
    cls,
    dayLabel: DAY_LABELS[cls.day],
    hours: hoursForDay(cls.day),
    gradeLevels: GRADE_LEVELS,
    colorPalette: COLOR_PALETTE,
    selectedGrades: ageGroupList(cls.age_group),
    availableStudents: activeStudents().filter((s) => !enrolledIds.includes(s.id)),
    enrolledStudents: cls.students.map((s) => ({ ...s, age: ageFromBirthday(s.birthday) })),
    availableStaff: activeParentsForStaff().filter((p) => !staffIds.includes(p.id)),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/class-schedule/classes/:id', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const className = (req.body.className || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (!className || !HOUR_POSITIONS.includes(hourPosition)) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent('Class name and hour are required.'));
  }

  updateClass(id, {
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

router.post('/class-schedule/classes/:id/delete', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  deleteClass(id);
  res.redirect(`/admin/class-schedule/${cls.day}?notice=` + encodeURIComponent(`Deleted "${cls.class_name}".`));
});

router.post('/class-schedule/classes/:id/enrollment/add', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const addIds = [].concat(req.body.studentIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  const existingIds = cls.students.map((s) => s.id);
  setEnrollment(id, [...new Set([...existingIds, ...addIds])]);
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/enrollment/:studentId/remove', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const studentId = parseInt(req.params.studentId, 10);
  setEnrollment(id, cls.students.map((s) => s.id).filter((sid) => sid !== studentId));
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/add', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const memberId = parseInt(req.body.memberId, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  if (memberId) addStaff(id, memberId, role);
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.post('/class-schedule/classes/:id/staff/:memberId/remove', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  removeStaff(id, parseInt(req.params.memberId, 10));
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

// Combined "+ Add Member" dialog on the View popup's roster - one form,
// role picks whether it enrolls a student or staffs a teacher/assistant.
router.post('/class-schedule/classes/:id/roster/add', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const role = req.body.role;
  if (role === 'student') {
    const studentId = parseInt(req.body.studentId, 10);
    if (studentId) {
      const existingIds = cls.students.map((s) => s.id);
      if (!existingIds.includes(studentId)) setEnrollment(id, [...existingIds, studentId]);
    }
  } else if (role === 'teacher' || role === 'assistant') {
    const staffId = parseInt(req.body.staffId, 10);
    if (staffId) addStaff(id, staffId, role);
  }
  res.redirect(`/admin/class-schedule/${cls.day}`);
});

router.get('/class-schedule/classes/:id/roster/export.csv', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');

  const lines = [toCsvRow(['Name', 'Role', 'Grade Level', 'Medical Notes'])];
  cls.staff.forEach((s) => lines.push(toCsvRow([s.name, s.role === 'assistant' ? 'Assistant' : 'Teacher', '', ''])));
  cls.students.forEach((s) => lines.push(toCsvRow([s.name, 'Student', s.grade_level || '', s.medical_notes || ''])));

  sendCsv(res, `${cls.class_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-roster.csv`, lines);
});

router.get('/class-schedule/classes/:id/roster/print', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  res.render('class-schedule-roster-print', {
    title: `${cls.class_name} Roster`,
    cls,
    dayLabel: DAY_LABELS[cls.day],
  });
});

router.get('/class-schedule/classes/:id/roster/import-template.xlsx', requireFullAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(['Student Name'], [['Jane Smith'], ['John Smith']]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="class-roster-import-template.xlsx"');
  res.send(buffer);
});

router.post('/class-schedule/classes/:id/roster/import', requireFullAdmin, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  if (!req.file) {
    return res.redirect(`/admin/class-schedule/${cls.day}?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = readRowsFromFile(req.file.buffer);
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
    const student = db.prepare("SELECT id FROM members WHERE name = ? COLLATE NOCASE AND member_type = 'student' AND active = 1").get(name);
    if (student && !existingIds.includes(student.id) && !addIds.includes(student.id)) addIds.push(student.id);
    else if (!student) skipped++;
  }
  if (addIds.length > 0) setEnrollment(id, [...existingIds, ...addIds]);

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

router.post('/class-schedule/:day/import', requireFullAdmin, requireDay, upload.single('file'), (req, res) => {
  const day = req.params.day;
  if (!req.file) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = readRowsFromFile(req.file.buffer).map(normalizeImportRow).filter((r) => r.className && r.hour);
  } catch (err) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  let created = 0;
  let skipped = 0;
  for (const r of rows) {
    const rowDay = (r.day || day).toLowerCase();
    if (rowDay !== 'monday' && rowDay !== 'wednesday') { skipped++; continue; }
    const hourPosition = parseInt(r.hour, 10);
    if (!HOUR_POSITIONS.includes(hourPosition)) { skipped++; continue; }
    createClass({ day: rowDay, hourPosition, className: r.className, room: r.room, ageGroup: r.ageGroup });
    created++;
  }

  res.redirect(
    `/admin/class-schedule/${day}?notice=` +
      encodeURIComponent(`Imported ${created} class(es)` + (skipped ? `, ${skipped} row(s) skipped.` : '.'))
  );
});

router.get('/class-schedule/:day/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const grid = gridForDay(day);

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

router.get('/class-schedule/:day/print', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  res.render('admin-class-schedule-print', {
    title: `${DAY_LABELS[day]} Class Schedule`,
    dayLabel: DAY_LABELS[day],
    grid: gridForDay(day),
  });
});

module.exports = router;

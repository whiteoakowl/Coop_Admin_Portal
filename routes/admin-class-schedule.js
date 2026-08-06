const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { requireDay } = require('../utils/days');
const { isValidISODate, todayISO, weekdayOf } = require('../utils/dates');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const {
  DAY_LABELS,
  HOUR_POSITIONS,
  defaultDay,
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

router.get('/class-schedule/:day', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateFor(day);
  res.render('admin-class-schedule', {
    title: 'Class Schedule',
    day,
    dayLabel: DAY_LABELS[day],
    hours: hoursForDay(day),
    roomGrid: roomGridForDay(day),
    selectedDate,
    absentIds: absentMemberIdsForDate(selectedDate),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/class-schedule/:day/hours', requireFullAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const labels = [].concat(req.body.labels || []);
  saveHourLabels(day, labels);
  res.redirect(`/admin/class-schedule/${day}?notice=` + encodeURIComponent('Hour labels updated.'));
});

router.post('/class-schedule/:day/classes/new', requireFullAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const className = (req.body.className || '').trim();
  const hourPosition = parseInt(req.body.hourPosition, 10);
  if (!className || !HOUR_POSITIONS.includes(hourPosition)) {
    return res.redirect(`/admin/class-schedule/${day}?error=` + encodeURIComponent('Class name and hour are required.'));
  }
  const id = createClass({
    day,
    hourPosition,
    className,
    room: (req.body.room || '').trim(),
    ageGroup: (req.body.ageGroup || '').trim(),
    color: req.body.color || null,
  });
  res.redirect(`/admin/class-schedule/classes/${id}/manage`);
});

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
    availableStudents: activeStudents().filter((s) => !enrolledIds.includes(s.id)),
    enrolledStudents: cls.students,
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
    return res.redirect(`/admin/class-schedule/classes/${id}/manage?error=` + encodeURIComponent('Class name and hour are required.'));
  }

  updateClass(id, {
    day: cls.day,
    hourPosition,
    className,
    room: (req.body.room || '').trim(),
    ageGroup: (req.body.ageGroup || '').trim(),
    color: req.body.color || cls.color,
    notes: (req.body.notes || '').trim(),
  });
  res.redirect(`/admin/class-schedule/classes/${id}/manage?notice=` + encodeURIComponent('Class updated.'));
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
  res.redirect(`/admin/class-schedule/classes/${id}/manage`);
});

router.post('/class-schedule/classes/:id/enrollment/:studentId/remove', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const studentId = parseInt(req.params.studentId, 10);
  setEnrollment(id, cls.students.map((s) => s.id).filter((sid) => sid !== studentId));
  res.redirect(`/admin/class-schedule/classes/${id}/manage`);
});

router.post('/class-schedule/classes/:id/staff/add', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  const memberId = parseInt(req.body.memberId, 10);
  const role = req.body.role === 'assistant' ? 'assistant' : 'teacher';
  if (memberId) addStaff(id, memberId, role);
  res.redirect(`/admin/class-schedule/classes/${id}/manage`);
});

router.post('/class-schedule/classes/:id/staff/:memberId/remove', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cls = getClass(id);
  if (!cls) return res.status(404).send('Not found');
  removeStaff(id, parseInt(req.params.memberId, 10));
  res.redirect(`/admin/class-schedule/classes/${id}/manage`);
});

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

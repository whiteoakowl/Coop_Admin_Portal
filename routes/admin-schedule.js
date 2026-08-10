const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { isValidISODate, todayISO, weekdayOf } = require('../utils/dates');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const {
  DAY_LABELS,
  getMemberSchedule,
  scheduleList,
} = require('../utils/schedule');
const { byLastName } = require('../utils/members');
const {
  DAY_LABELS: CLASS_DAY_LABELS,
  isValidDay,
  hoursForDay,
  roomGridForDay,
  roomsForDay,
  GRADE_LEVELS,
  activeParentsForStaff,
  absentMemberIdsForDate,
  setEnrollment,
  addStaff,
} = require('../utils/classSchedule');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { imageFileFilter, spreadsheetFileFilter } = require('../utils/uploads');
const { sweepScheduleCardImages } = require('../utils/designImageGC');

const uploadScheduleImport = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'schedule-cards');
if (!fs.existsSync(DESIGN_IMAGE_DIR)) fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });

const uploadDesignImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DESIGN_IMAGE_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

const SCHEDULE_TABS = ['monday', 'wednesday', 'students', 'parents'];
const DAY_WEEKDAY = { monday: 1, wednesday: 3 };
const PAGE_SIZE = 25;

// Only defaults the absence-highlight date picker to today when today
// actually falls on the tab's day - otherwise there's nothing meaningful
// to highlight yet (mirrors admin-class-schedule.js's defaultDateFor).
function defaultDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === DAY_WEEKDAY[day] ? today : '';
}

router.get('/schedule', requireAdmin, (req, res) => {
  let tab = SCHEDULE_TABS.includes(req.query.tab) ? req.query.tab : 'monday';

  // Student/Parent Schedules is the per-member schedule list + editor -
  // full-Admin-only. A Co-op Admin only gets the read-only day grid.
  if ((tab === 'students' || tab === 'parents') && !res.locals.isFullAdmin) {
    tab = 'monday';
  }

  if (tab === 'monday' || tab === 'wednesday') {
    const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateFor(tab);
    return res.render('admin-schedule', {
      title: 'Schedules',
      tab,
      topTab: 'schedules',
      day: tab,
      dayLabel: CLASS_DAY_LABELS[tab],
      hours: hoursForDay(tab),
      roomGrid: roomGridForDay(tab),
      rooms: roomsForDay(tab),
      gradeLevels: GRADE_LEVELS,
      availableStaff: activeParentsForStaff(),
      selectedDate,
      absentIds: absentMemberIdsForDate(selectedDate),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Student Schedules / Parent Schedules: every active member of that
  // type, shown as their actual Schedule Card (same design/rendering as
  // the printable card - see partials/name-tag-badge.ejs), laid out side
  // by side in alphabetical-by-last-name order. The old free-text search
  // is now a dropdown of every name in this tab, jumping straight to one
  // person's card via the memberId filter scheduleList already supports.
  const memberType = tab === 'parents' ? 'parent' : 'student';
  const selectedMemberId = req.query.memberId ? parseInt(req.query.memberId, 10) : null;
  const filters = { memberType, memberId: selectedMemberId || undefined };

  const rows = scheduleList(filters);

  const scheduleCardTemplate = getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  const summarized = rows.map((r) => ({
    member: r.member,
    scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(r.member)),
  }));
  summarized.sort((a, b) => byLastName(a.member, b.member));

  const allNames = db
    .prepare('SELECT id, name FROM members WHERE active = 1 AND member_type = ?')
    .all(memberType)
    .sort(byLastName);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(summarized.length / PAGE_SIZE));
  const pageRows = summarized.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.render('admin-schedule', {
    title: 'Schedules',
    tab,
    topTab: tab,
    rows: pageRows,
    totalCount: summarized.length,
    page,
    totalPages,
    scheduleCardBgCss,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    allNames,
    selectedMemberId,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Student/Parent Schedules: bulk import ---
//
// Matches each row to an existing class by day + class name + start time
// (the class has to already exist on the Class Schedule - this only ever
// enrolls/staffs someone onto one, it never creates classes) and adds the
// member to that class's roster: a student row enrolls them as a
// student, a parent row adds them as that class's teacher. No Teacher or
// End Time columns - a schedule row is just "this person, this class,
// starting at this time".
const SCHEDULE_IMPORT_TABS = { students: 'student', parents: 'parent' };

function normalizeMatchText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

router.get('/schedule/:tab/import-template.xlsx', requireFullAdmin, (req, res) => {
  const tab = req.params.tab;
  if (!SCHEDULE_IMPORT_TABS[tab]) return res.status(404).send('Not found');
  const buffer = buildTemplateWorkbook(
    ['Member Name', 'Day', 'Class Name', 'Start Time'],
    [
      ['Jane Smith', 'Monday', 'Art Adventures', '9:00 AM'],
      ['John Smith', 'Wednesday', 'PE', '10:00 AM'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${tab}-schedule-import-template.xlsx"`);
  res.send(buffer);
});

const SCHEDULE_IMPORT_ALIASES = {
  name: ['member name', 'name'],
  day: ['day'],
  className: ['class name', 'class', 'subject'],
  startTime: ['start time', 'time'],
};

function normalizeScheduleImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const out = {};
  for (const [field, aliases] of Object.entries(SCHEDULE_IMPORT_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] !== undefined && String(lowerMap[alias]).trim() !== '') {
        out[field] = String(lowerMap[alias]).trim();
        break;
      }
    }
  }
  return out;
}

router.post('/schedule/:tab/import', requireFullAdmin, uploadScheduleImport.single('file'), (req, res) => {
  const tab = req.params.tab;
  const memberType = SCHEDULE_IMPORT_TABS[tab];
  if (!memberType) return res.status(404).send('Not found');
  const redirectBase = `/admin/schedule?tab=${tab}`;

  if (!req.file) {
    return res.redirect(`${redirectBase}&error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = readRowsFromFile(req.file.buffer).map(normalizeScheduleImportRow).filter((r) => r.name && r.day && r.className);
  } catch (err) {
    return res.redirect(`${redirectBase}&error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  let matched = 0;
  let skipped = 0;

  for (const r of rows) {
    const day = r.day.toLowerCase();
    if (!isValidDay(day)) { skipped++; continue; }

    const member = db
      .prepare('SELECT id FROM members WHERE name = ? COLLATE NOCASE AND member_type = ? AND active = 1')
      .get(r.name, memberType);
    if (!member) { skipped++; continue; }

    const candidates = db
      .prepare('SELECT * FROM classes WHERE day = ? AND class_name = ? COLLATE NOCASE')
      .all(day, r.className);
    let cls = candidates[0];
    if (candidates.length > 1) {
      cls = candidates.find((c) => normalizeMatchText(c.start_time) === normalizeMatchText(r.startTime)) || null;
    } else if (candidates.length === 1 && r.startTime && candidates[0].start_time) {
      cls = normalizeMatchText(candidates[0].start_time) === normalizeMatchText(r.startTime) ? candidates[0] : null;
    }
    if (!cls) { skipped++; continue; }

    if (memberType === 'student') {
      const existingIds = db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(cls.id).map((e) => e.student_id);
      if (!existingIds.includes(member.id)) setEnrollment(cls.id, [...existingIds, member.id]);
    } else {
      addStaff(cls.id, member.id, 'teacher');
    }
    matched++;
  }

  res.redirect(
    `${redirectBase}&notice=` +
      encodeURIComponent(`Matched ${matched} schedule row(s)` + (skipped ? `, ${skipped} skipped (no matching class or member).` : '.'))
  );
});

router.post('/schedule/print-cards', requireFullAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = db
    .prepare(`SELECT * FROM members WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`)
    .all(...memberIds);

  const template = getScheduleCardTemplate();
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const cards = members.map((m) => ({
    html: NameTagRenderCore.renderBadgeElements(template.elements, scheduleCardDataForMember(m)),
    bgCss,
  }));

  res.render('admin-schedule-print-cards', {
    title: 'Print Schedule Cards',
    cards,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
  });
});

router.post('/schedule/design/template', requireFullAdmin, (req, res) => {
  let layout;
  try {
    layout = typeof req.body.layout === 'string' ? JSON.parse(req.body.layout) : req.body.layout;
  } catch (err) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }
  if (!layout || !Array.isArray(layout.elements)) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }

  db.prepare(
    `INSERT INTO schedule_card_templates (id, layout_json, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = datetime('now')`
  ).run(JSON.stringify(layout));

  // See the equivalent comment in routes/admin-name-tag.js's own
  // template-save route - a layout can add/remove any number of image
  // elements with no simple "this upload replaces that one" moment to
  // hook cleanup onto, so this re-derives what's still referenced and
  // sweeps anything left over instead.
  sweepScheduleCardImages();

  res.json({ ok: true });
});

router.post('/schedule/design-image', requireFullAdmin, uploadDesignImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  res.json({ ok: true, url: `/uploads/schedule-cards/${req.file.filename}` });
});

// Read-only - member_schedules is entirely derived from the master Class
// Schedule now (see syncMemberSchedulesForDay in utils/classSchedule.js),
// so there's nothing to hand-edit here anymore. Enroll/staff the member on
// the Schedules page to change what shows up.
router.get('/schedule/member/:id/manage', requireFullAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  const { monday, wednesday } = getMemberSchedule(id);
  res.render('admin-schedule-manage', {
    title: `Schedule - ${member.name}`,
    member,
    monday,
    wednesday,
    dayLabels: DAY_LABELS,
    returnTab: member.member_type === 'parent' ? 'parents' : 'students',
  });
});

router.get('/schedule/export.csv', requireFullAdmin, (req, res) => {
  const filters = {
    search: (req.query.search || '').trim(),
    day: ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '',
    grade: req.query.grade || '',
    teacher: req.query.teacher || '',
    room: req.query.room || '',
    className: req.query.className || '',
    rosterId: req.query.rosterId ? parseInt(req.query.rosterId, 10) : null,
    memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null,
  };
  const rows = scheduleList(filters);

  const lines = [toCsvRow(['Member Name', 'Day', 'Class Number', 'Time', 'Class Name', 'Room', 'Teacher'])];
  rows.forEach((r) => {
    [['monday', r.monday], ['wednesday', r.wednesday]].forEach(([day, dayRows]) => {
      dayRows.forEach((c) => {
        if (!c.class_name && !c.room && !c.time && !c.teacher) return;
        lines.push(toCsvRow([r.member.name, day, c.class_number, c.time || '', c.class_name || '', c.room || '', c.teacher || '']));
      });
    });
  });

  sendCsv(res, 'class-schedules.csv', lines);
});

router.get('/schedule/print', requireFullAdmin, (req, res) => {
  const filters = {
    search: (req.query.search || '').trim(),
    day: ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '',
    grade: req.query.grade || '',
    teacher: req.query.teacher || '',
    room: req.query.room || '',
    className: req.query.className || '',
    rosterId: req.query.rosterId ? parseInt(req.query.rosterId, 10) : null,
    memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null,
  };
  const rows = scheduleList(filters);
  res.render('admin-schedule-print', { title: 'Print Schedules', rows });
});

module.exports = router;

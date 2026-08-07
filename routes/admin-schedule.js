const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { formatTimestamp, isValidISODate, todayISO, weekdayOf } = require('../utils/dates');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const {
  DAY_LABELS,
  STATUS_LABELS,
  getMemberSchedule,
  scheduleList,
} = require('../utils/schedule');
const {
  DAY_LABELS: CLASS_DAY_LABELS,
  hoursForDay,
  roomGridForDay,
  roomsForDay,
  renameRoom,
  GRADE_LEVELS,
  activeParentsForStaff,
  absentMemberIdsForDate,
} = require('../utils/classSchedule');
const { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { imageFileFilter } = require('../utils/uploads');
const { jsonScriptSafe } = require('../utils/json');

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

function summarizeDay(rows) {
  const filled = rows.filter((r) => r.class_name || r.room || r.time || r.teacher);
  if (filled.length === 0) return '—';
  return filled.map((r) => r.class_name || r.room || r.time).filter(Boolean).join(', ');
}

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
      title: 'Schedule',
      tab,
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

  // Student Schedules / Parent Schedules: the same per-member schedule
  // list, filtered to one member_type.
  const memberType = tab === 'parents' ? 'parent' : 'student';
  const filters = { search: (req.query.search || '').trim(), memberType };

  let sort = ['name', 'monday', 'wednesday', 'status', 'updated'].includes(req.query.sort) ? req.query.sort : 'name';
  let dir = req.query.dir === 'desc' ? 'desc' : 'asc';

  const rows = scheduleList(filters);

  const summarized = rows.map((r) => ({
    member: r.member,
    mondaySummary: summarizeDay(r.monday),
    wednesdaySummary: summarizeDay(r.wednesday),
    status: r.status,
    statusLabel: STATUS_LABELS[r.status],
    lastUpdated: r.lastUpdated ? formatTimestamp(r.lastUpdated) : 'Never',
    lastUpdatedRaw: r.lastUpdated || '',
  }));

  const dirMul = dir === 'desc' ? -1 : 1;
  summarized.sort((a, b) => {
    let av, bv;
    if (sort === 'name') { av = a.member.name.toLowerCase(); bv = b.member.name.toLowerCase(); }
    else if (sort === 'monday') { av = a.mondaySummary; bv = b.mondaySummary; }
    else if (sort === 'wednesday') { av = a.wednesdaySummary; bv = b.wednesdaySummary; }
    else if (sort === 'status') { av = a.status; bv = b.status; }
    else { av = a.lastUpdatedRaw; bv = b.lastUpdatedRaw; }
    if (av < bv) return -1 * dirMul;
    if (av > bv) return 1 * dirMul;
    return 0;
  });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(summarized.length / PAGE_SIZE));
  const pageRows = summarized.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.render('admin-schedule', {
    title: 'Schedule',
    tab,
    rows: pageRows,
    totalCount: summarized.length,
    page,
    totalPages,
    sort,
    dir,
    filters,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
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

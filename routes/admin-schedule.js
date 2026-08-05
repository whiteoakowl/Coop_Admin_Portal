const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { formatTimestamp } = require('../utils/dates');
const { buildTemplateWorkbook, readRowsFromFile, toCsvRow, sendCsv } = require('../utils/spreadsheet');
const {
  DAYS,
  DAY_LABELS,
  STATUS_LABELS,
  getMemberSchedule,
  saveMemberSchedule,
  scheduleList,
} = require('../utils/schedule');
const { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { imageFileFilter } = require('../utils/uploads');
const { jsonScriptSafe } = require('../utils/json');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

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

const SCHEDULE_TABS = ['classes', 'design', 'print'];
const PAGE_SIZE = 25;

function summarizeDay(rows) {
  const filled = rows.filter((r) => r.class_name || r.room || r.time || r.teacher);
  if (filled.length === 0) return '—';
  return filled.map((r) => r.class_name || r.room || r.time).filter(Boolean).join(', ');
}

router.get('/schedule', requireAdmin, (req, res) => {
  const tab = SCHEDULE_TABS.includes(req.query.tab) ? req.query.tab : 'classes';

  const filters = { search: (req.query.search || '').trim() };

  let rows = [];
  let sort = ['name', 'monday', 'wednesday', 'status', 'updated'].includes(req.query.sort) ? req.query.sort : 'name';
  let dir = req.query.dir === 'desc' ? 'desc' : 'asc';

  if (tab === 'classes') {
    rows = scheduleList(filters);

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

    return res.render('admin-schedule', {
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
  }

  if (tab === 'design') {
    return res.render('admin-schedule', {
      title: 'Schedule',
      tab,
      rows: [],
      totalCount: 0,
      page: 1,
      totalPages: 1,
      sort,
      dir,
      filters,
      scheduleCardDataJson: jsonScriptSafe({
        template: getScheduleCardTemplate(),
        defaultLayout: DEFAULT_LAYOUT,
        fields: FIELDS,
        tableFields: TABLE_FIELDS,
        shapeTypes: SHAPE_TYPES,
        fontFamilies: FONT_FAMILIES,
        cardWidth: CARD_WIDTH,
        cardHeight: CARD_HEIGHT,
      }),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Print Cards tab: a plain member picker (search + select), like the
  // Name Tag Designer's Print tab.
  const printMembers = db
    .prepare("SELECT id, name FROM members WHERE active = 1 AND member_type = 'student' ORDER BY name COLLATE NOCASE")
    .all();

  res.render('admin-schedule', {
    title: 'Schedule',
    tab,
    rows: [],
    totalCount: 0,
    page: 1,
    totalPages: 1,
    sort,
    dir,
    filters,
    printMembers,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/schedule/print-cards', requireAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/schedule?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = db
    .prepare(`SELECT * FROM members WHERE id IN (${placeholders}) AND member_type = 'student' ORDER BY name COLLATE NOCASE`)
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

router.post('/schedule/design/template', requireAdmin, (req, res) => {
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

router.post('/schedule/design-image', requireAdmin, uploadDesignImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  res.json({ ok: true, url: `/uploads/schedule-cards/${req.file.filename}` });
});

router.get('/schedule/member/:id/manage', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare("SELECT * FROM members WHERE id = ? AND member_type = 'student'").get(id);
  if (!member) return res.status(404).send('Not found');
  const { monday, wednesday } = getMemberSchedule(id);
  res.render('admin-schedule-manage', {
    title: `Schedule - ${member.name}`,
    member,
    monday,
    wednesday,
    dayLabels: DAY_LABELS,
    notice: req.query.notice || null,
  });
});

router.post('/schedule/member/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = db.prepare("SELECT id FROM members WHERE id = ? AND member_type = 'student'").get(id);
  if (!member) return res.status(404).send('Not found');

  const dayRows = {};
  DAYS.forEach((day) => {
    dayRows[day] = [1, 2, 3, 4].map((n) => ({
      time: req.body[`time:${day}:${n}`] || '',
      className: req.body[`className:${day}:${n}`] || '',
      room: req.body[`room:${day}:${n}`] || '',
      teacher: req.body[`teacher:${day}:${n}`] || '',
    }));
  });
  saveMemberSchedule(id, dayRows);
  res.redirect(`/admin/schedule/member/${id}/manage?notice=` + encodeURIComponent('Schedule saved.'));
});

router.get('/schedule/import-template.xlsx', requireAdmin, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Full Name', 'Day', 'Class Number', 'Time', 'Class Name', 'Room', 'Teacher'],
    [
      ['Alice Smith', 'Monday', '1', '9:00 AM - 9:45 AM', 'Math', 'Room 12', 'Mrs. Jones'],
      ['Alice Smith', 'Monday', '2', '10:00 AM - 10:45 AM', 'Science', 'Room 8', 'Mr. Lee'],
      ['Alice Smith', 'Wednesday', '1', '9:00 AM - 9:45 AM', 'Art', 'Room 3', 'Ms. Diaz'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="schedule-import-template.xlsx"');
  res.send(buffer);
});

const SCHEDULE_IMPORT_ALIASES = {
  name: ['full name', 'name', 'member name'],
  day: ['day'],
  classNumber: ['class number', 'class #', 'period', 'class'],
  time: ['time'],
  className: ['class name', 'subject'],
  room: ['room'],
  teacher: ['teacher'],
};

function normalizeScheduleRow(row) {
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

router.post('/schedule/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect('/admin/schedule?error=' + encodeURIComponent('Please choose a file to import.'));

  let rawRows;
  try {
    rawRows = readRowsFromFile(req.file.buffer).map(normalizeScheduleRow);
  } catch (err) {
    return res.redirect('/admin/schedule?error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  const summary = { imported: 0, updated: 0, created: 0, duplicate: 0, unmatched: 0, errors: 0, warnings: 0 };
  const byMember = {}; // memberId -> { monday: {classNumber: row}, wednesday: {...} }
  const seenKeys = new Set();

  rawRows.forEach((r) => {
    if (!r.name || !r.day || !r.classNumber) {
      summary.errors++;
      return;
    }
    const day = r.day.trim().toLowerCase();
    if (day !== 'monday' && day !== 'wednesday') {
      summary.errors++;
      return;
    }
    const classNumber = parseInt(r.classNumber, 10);
    if (!classNumber || classNumber < 1 || classNumber > 4) {
      summary.errors++;
      return;
    }
    const member = db.prepare("SELECT id FROM members WHERE active = 1 AND member_type = 'student' AND name = ? COLLATE NOCASE").get(r.name);
    if (!member) {
      summary.unmatched++;
      return;
    }

    const key = `${member.id}|${day}|${classNumber}`;
    if (seenKeys.has(key)) {
      summary.duplicate++;
      return;
    }
    seenKeys.add(key);
    if (!r.time && !r.className && !r.room && !r.teacher) summary.warnings++;

    if (!byMember[member.id]) byMember[member.id] = { monday: {}, wednesday: {} };
    byMember[member.id][day][classNumber] = { time: r.time || '', className: r.className || '', room: r.room || '', teacher: r.teacher || '' };
    summary.imported++;
  });

  Object.entries(byMember).forEach(([memberId, days]) => {
    const existing = getMemberSchedule(parseInt(memberId, 10));
    const hadExisting = existing.monday.some((r) => r.class_name || r.room || r.time || r.teacher) || existing.wednesday.some((r) => r.class_name || r.room || r.time || r.teacher);

    const dayRows = {};
    DAYS.forEach((day) => {
      dayRows[day] = [1, 2, 3, 4].map((n) => {
        const incoming = days[day][n];
        if (incoming) return incoming;
        const existingRow = existing[day][n - 1];
        return { time: existingRow.time, className: existingRow.class_name, room: existingRow.room, teacher: existingRow.teacher };
      });
    });
    saveMemberSchedule(parseInt(memberId, 10), dayRows);
    if (hadExisting) summary.updated++;
    else summary.created++;
  });

  const parts = [
    `${summary.imported} row(s) imported`,
    `${summary.created} new schedule(s) created`,
    `${summary.updated} schedule(s) updated`,
  ];
  if (summary.duplicate) parts.push(`${summary.duplicate} duplicate row(s) skipped`);
  if (summary.unmatched) parts.push(`${summary.unmatched} unmatched name(s)`);
  if (summary.errors) parts.push(`${summary.errors} error(s)`);
  if (summary.warnings) parts.push(`${summary.warnings} warning(s) (blank rows)`);

  res.redirect('/admin/schedule?notice=' + encodeURIComponent(parts.join(', ') + '.'));
});

router.get('/schedule/export.csv', requireAdmin, (req, res) => {
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

router.get('/schedule/print', requireAdmin, (req, res) => {
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

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { formatTimestamp, formatDateLabel } = require('../utils/dates');

router.use(requireFullAdmin);
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { isMiscBadgeType, saveMiscTemplate } = require('../utils/miscBadgeData');
const { imageFileFilter } = require('../utils/uploads');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { jsonScriptSafe } = require('../utils/json');
const { DAY_LABELS: BASE_DAY_LABELS } = require('../utils/days');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
// A name tag request can also be filed for "both" days, unlike every other
// :day-scoped feature - extend the shared Monday/Wednesday labels rather
// than redefining them.
const DAY_LABELS = { ...BASE_DAY_LABELS, both: 'Both' };

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'name-tags');
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

const NAME_TAG_TABS = ['design', 'print', 'requests', 'archived'];

function nameTagSubmissions(showArchived, dateFilter) {
  let sql = `SELECT n.id AS id, m.name AS memberName, n.request_type AS requestType, n.day AS day,
             n.description AS description, n.created_at AS createdAt
             FROM name_tag_requests n
             JOIN members m ON m.id = n.member_id
             WHERE n.archived = ?`;
  const params = [showArchived ? 1 : 0];
  if (dateFilter) {
    sql += ' AND date(n.created_at) = ?';
    params.push(dateFilter);
  }
  sql += ' ORDER BY n.created_at DESC';

  return db.prepare(sql).all(...params);
}

router.get('/name-tag', requireAdmin, (req, res) => {
  const tab = NAME_TAG_TABS.includes(req.query.tab) ? req.query.tab : 'design';
  const showArchived = tab === 'archived';
  const dateFilter = req.query.date || '';

  const submissions = nameTagSubmissions(showArchived, dateFilter).map((r) => ({
    id: r.id,
    timestamp: formatTimestamp(r.createdAt),
    memberName: r.memberName,
    requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
    dayLabel: DAY_LABELS[r.day] || r.day,
    description: r.description || '—',
  }));

  const dates = db
    .prepare(`SELECT DISTINCT date(created_at) AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`)
    .all(showArchived ? 1 : 0)
    .map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));

  const members = db
    .prepare("SELECT id, name, member_type FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE")
    .all();

  res.render('admin-name-tag', {
    title: 'Name Tags',
    tab,
    submissions,
    dates,
    dateFilter,
    showArchived,
    members,
    nameTagDataJson: jsonScriptSafe({
      templates: { student: getTemplate('student'), parent: getTemplate('parent') },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
  });
});

router.get('/name-tag/requests/export.csv', requireAdmin, (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = nameTagSubmissions(showArchived, dateFilter);

  const lines = [
    toCsvRow(['Submitted', 'Name', 'Request', 'Day', 'Description']),
    ...submissions.map((r) =>
      toCsvRow([
        formatTimestamp(r.createdAt),
        r.memberName,
        REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
        DAY_LABELS[r.day] || r.day,
        r.description || '',
      ])
    ),
  ];

  sendCsv(res, `name-tag-${showArchived ? 'archived' : 'requests'}.csv`, lines);
});

router.post('/name-tag/:id/archive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(id);
  res.redirect('/admin/name-tag?tab=requests');
});

router.post('/name-tag/:id/unarchive', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(id);
  res.redirect('/admin/name-tag?tab=archived');
});

const NAME_TAG_TYPES = ['student', 'parent'];

// This same save endpoint is shared by the Setup/Cleanup and Custom badge
// types (they use the same editor - see public/js/name-tag-editor.js) -
// member-type name tags persist to name_tag_templates, misc badge types to
// their own misc_badge_templates table (see utils/miscBadgeData.js).
router.post('/name-tag/template/:type', requireAdmin, (req, res) => {
  const type = req.params.type;
  if (!NAME_TAG_TYPES.includes(type) && !isMiscBadgeType(type)) return res.status(404).json({ ok: false });

  let layout;
  try {
    layout = typeof req.body.layout === 'string' ? JSON.parse(req.body.layout) : req.body.layout;
  } catch (err) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }
  if (!layout || !Array.isArray(layout.elements)) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }

  if (isMiscBadgeType(type)) {
    saveMiscTemplate(type, layout);
    return res.json({ ok: true });
  }

  db.prepare(
    `INSERT INTO name_tag_templates (member_type, layout_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(member_type) DO UPDATE SET layout_json = excluded.layout_json, updated_at = datetime('now')`
  ).run(type, JSON.stringify(layout));

  res.json({ ok: true });
});

router.post('/name-tag/design-image', requireAdmin, uploadDesignImage.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  res.json({ ok: true, url: `/uploads/name-tags/${req.file.filename}` });
});

router.post('/name-tag/print', requireAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/name-tag?error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM members WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`).all(...memberIds);

  const templates = { student: getTemplate('student'), parent: getTemplate('parent') };
  const badges = members.map((m) => {
    const layout = templates[m.member_type] || templates.student;
    const data = badgeDataForMember(m);
    return {
      html: NameTagRenderCore.renderBadgeElements(layout.elements, data),
      bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
    };
  });

  res.render('admin-name-tag-bulk-print', {
    title: 'Print Name Tags',
    badges,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
  });
});

// Barcode-only sheet: just the scan code and name, no name tag design -
// for a cheap, fast-to-print stack of scan cards.
router.post('/name-tag/print-barcodes', requireAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/name-tag?error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT id, name, barcode FROM members WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`).all(...memberIds);

  res.render('admin-name-tag-barcode-print', {
    title: 'Print Barcodes',
    members,
  });
});

module.exports = router;

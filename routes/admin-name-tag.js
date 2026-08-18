const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { formatTimestamp, formatDateLabel } = require('../utils/dates');

router.use(requireFullAdmin);
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { isMiscBadgeType, saveMiscTemplate } = require('../utils/miscBadgeData');
const { imageFileFilter } = require('../utils/uploads');
const { sweepNameTagImages } = require('../utils/designImageGC');
const { createStorageClient, publicUrl } = require('../utils/storage');
const { saveUpload } = require('../utils/uploadBackend');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { jsonScriptSafe } = require('../utils/json');
const { DAY_LABELS: BASE_DAY_LABELS } = require('../utils/days');
const { byLastName } = require('../utils/members');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

const REQUEST_TYPE_LABELS = { lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
// A name tag request can also be filed for "both" days, unlike every other
// :day-scoped feature - extend the shared Monday/Wednesday labels rather
// than redefining them.
const DAY_LABELS = { ...BASE_DAY_LABELS, both: 'Both' };

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'name-tags');
const NAME_TAG_IMAGES_BUCKET = 'name-tag-images';
const storageClient = createStorageClient();
// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured.
if (!storageClient && !fs.existsSync(DESIGN_IMAGE_DIR)) fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });

const uploadDesignImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

const NAME_TAG_TABS = ['design', 'print', 'requests', 'archived'];

async function nameTagSubmissions(showArchived, dateFilter) {
  let sql = `SELECT n.id AS id, m.name AS "memberName", n.request_type AS "requestType", n.day AS day,
             n.description AS description, n.created_at AS "createdAt"
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

router.get('/name-tag', async (req, res) => {
  const tab = NAME_TAG_TABS.includes(req.query.tab) ? req.query.tab : 'design';
  const showArchived = tab === 'archived';
  const dateFilter = req.query.date || '';

  const submissions = (await nameTagSubmissions(showArchived, dateFilter)).map((r) => ({
    id: r.id,
    timestamp: formatTimestamp(r.createdAt),
    memberName: r.memberName,
    requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
    dayLabel: DAY_LABELS[r.day] || r.day,
    description: r.description || '—',
  }));

  const dates = (
    await db.prepare(`SELECT DISTINCT date(created_at)::text AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`).all(showArchived ? 1 : 0)
  ).map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));

  const members = (await db.prepare('SELECT id, name, member_type FROM members WHERE active = 1').all()).sort(byLastName);

  res.render('admin-name-tag', {
    title: 'Name Tags',
    tab,
    submissions,
    dates,
    dateFilter,
    showArchived,
    members,
    nameTagDataJson: jsonScriptSafe({
      templates: { student: await getTemplate('student'), parent: await getTemplate('parent') },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
  });
});

router.get('/name-tag/requests/export.csv', async (req, res) => {
  const showArchived = req.query.archived === '1';
  const dateFilter = req.query.date || '';
  const submissions = await nameTagSubmissions(showArchived, dateFilter);

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

router.post('/name-tag/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(id);
  res.redirect('/admin/name-tag?tab=requests');
});

router.post('/name-tag/:id/unarchive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(id);
  res.redirect('/admin/name-tag?tab=archived');
});

const NAME_TAG_TYPES = ['student', 'parent'];

// This same save endpoint is shared by the Setup/Cleanup and Custom badge
// types (they use the same editor - see public/js/name-tag-editor.js) -
// member-type name tags persist to name_tag_templates, misc badge types to
// their own misc_badge_templates table (see utils/miscBadgeData.js).
router.post('/name-tag/template/:type', async (req, res) => {
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
    await saveMiscTemplate(type, layout);
    await sweepNameTagImages();
    return res.json({ ok: true });
  }

  await db
    .prepare(
      `INSERT INTO name_tag_templates (member_type, layout_json, updated_at) VALUES (?, ?, now_text())
       ON CONFLICT(member_type) DO UPDATE SET layout_json = excluded.layout_json, updated_at = now_text()`
    )
    .run(type, JSON.stringify(layout));

  // Removing/replacing an image element in the editor doesn't delete the
  // old upload on its own (a layout can add/remove any number of images,
  // unlike a member's single photo_path - there's no simple "this upload
  // replaces that one" moment to hook cleanup onto). Re-derive what's
  // still referenced across every name tag/misc badge template - they
  // share this upload directory - and sweep anything left over.
  await sweepNameTagImages();

  res.json({ ok: true });
});

router.post('/name-tag/design-image', uploadDesignImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  // Unlike photo_path, a layout's image element `src` is consumed
  // directly as a literal URL by client-side rendering code (the design
  // editor's live preview, public/js/name-tag-render-core.js) with no
  // server-side "look up the key, resolve the URL" step at render time -
  // so the *full* URL has to be handed back here, not a bare key (see
  // MIGRATION.md's own note on this deliberate exception).
  const key = await saveUpload({
    client: storageClient,
    bucket: NAME_TAG_IMAGES_BUCKET,
    localDir: DESIGN_IMAGE_DIR,
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    contentType: req.file.mimetype,
  });
  const url = storageClient ? publicUrl(NAME_TAG_IMAGES_BUCKET, key) : `/uploads/name-tags/${key}`;
  res.json({ ok: true, url });
});

router.post('/name-tag/print', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/name-tag?error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const templates = { student: await getTemplate('student'), parent: await getTemplate('parent') };
  // Every parent's cleanup team membership computed in ONE query, not one
  // per parent - a real bug report: printing ~800 cards timed out, the
  // same N+1 shape already fixed for Schedule Cards (routes/admin-
  // schedule.js's print-cards route) - see badgeDataForMembers's own
  // comment.
  const dataByMember = await badgeDataForMembers(members);
  const badges = members.map((m) => {
    const layout = templates[m.member_type] || templates.student;
    return {
      html: NameTagRenderCore.renderBadgeElements(layout.elements, dataByMember[m.id]),
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
router.post('/name-tag/print-barcodes', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/name-tag?error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT id, name, barcode FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  res.render('admin-name-tag-barcode-print', {
    title: 'Print Barcodes',
    members,
  });
});

// Barcode + name + ID mailing-label sheet: for printing directly onto
// Avery 08160-style address label sheets - unlike print-barcodes above
// (fixed 3in x 1.75in cards meant to be cut into a scan-card stack), this
// fits an off-the-shelf label sheet and adds each member's permanent ID
// number as plain text alongside the barcode.
router.post('/name-tag/print-barcode-labels', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/name-tag?error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (
    await db.prepare(`SELECT id, name, barcode, member_code FROM members WHERE id IN (${placeholders})`).all(...memberIds)
  ).sort(byLastName);

  res.render('admin-name-tag-barcode-labels-print', {
    title: 'Print Barcode Labels',
    members,
  });
});

module.exports = router;

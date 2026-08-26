// Name Tags, mirrored into Main Admin - a real request: "name tags can
// only be designed and bulk printed by main admin and co-op admin".
// Deliberately NOT a fork of routes/admin-name-tag.js's data layer -
// every template/badge-render helper here is the exact same shared
// utils/nameTagData.js, utils/nameTagBadge.js, and public/js/
// name-tag-render-core.js that router already uses, and
// name_tag_templates is one shared table either portal edits - so a
// design saved from either portal is the same design, not two drifting
// copies. Only the route wiring/auth gate (Main Admin's requirePortal-
// Permission instead of Co-op Admin's requireFullAdmin) and the views
// (Main Admin's own portal-nav instead of admin-nav) are new. The
// canvas-based design editor itself (public/js/name-tag-editor.js) is
// the literal same script tag, parameterized by a `basePath` in its JSON
// seed rather than forked - see that file's own comment.
//
// Scoped down from /admin/name-tag's full tab set on purpose: no
// Requests/Archived queue, CSV export, or Avery mailing-label sheet here
// - those stay Co-op-Admin-only for now. Design + full bulk print +
// barcode-only print (the actual "designed and bulk printed" ask) are
// full parity.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const { imageFileFilter } = require('../utils/uploads');
const { sweepNameTagImages } = require('../utils/designImageGC');
const { createStorageClient, publicUrl } = require('../utils/storage');
const { saveUpload } = require('../utils/uploadBackend');
const { jsonScriptSafe } = require('../utils/json');
const { byLastName } = require('../utils/members');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_name_tags'));

const NAME_TAG_TYPES = ['student', 'parent', 'admin'];
const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'name-tags');
const NAME_TAG_IMAGES_BUCKET = 'name-tag-images';
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(DESIGN_IMAGE_DIR)) fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });

const uploadDesignImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.get('/', async (req, res) => {
  const tab = req.query.tab === 'print' ? 'print' : 'design';
  const members = (await db.prepare('SELECT id, name, member_type FROM members WHERE active = 1').all()).sort(byLastName);

  res.render('main-admin-name-tags', {
    title: 'Name Tags',
    tab,
    members,
    error: req.query.error || null,
    nameTagDataJson: jsonScriptSafe({
      basePath: '/main-admin/name-tags',
      templates: { student: await getTemplate('student'), parent: await getTemplate('parent'), admin: await getTemplate('admin') },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
  });
});

router.post('/template/:type', async (req, res) => {
  const type = req.params.type;
  if (!NAME_TAG_TYPES.includes(type)) return res.status(404).json({ ok: false });

  let layout;
  try {
    layout = typeof req.body.layout === 'string' ? JSON.parse(req.body.layout) : req.body.layout;
  } catch (err) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }
  if (!layout || !Array.isArray(layout.elements)) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }

  await db
    .prepare(
      `INSERT INTO name_tag_templates (member_type, layout_json, updated_at) VALUES (?, ?, now_text())
       ON CONFLICT(member_type) DO UPDATE SET layout_json = excluded.layout_json, updated_at = now_text()`
    )
    .run(type, JSON.stringify(layout));
  await sweepNameTagImages();

  res.json({ ok: true });
});

router.post('/design-image', uploadDesignImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
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

router.post('/print', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const templates = { student: await getTemplate('student'), parent: await getTemplate('parent'), admin: await getTemplate('admin') };
  const dataByMember = await badgeDataForMembers(members);
  const badges = members.map((m) => {
    const layout = templates[m.member_type] || templates.student;
    return {
      html: NameTagRenderCore.renderBadgeElements(layout.elements, dataByMember[m.id]),
      bgCss: NameTagRenderCore.backgroundCss(layout.background, layout.backgroundOpacity),
    };
  });

  res.render('main-admin-name-tag-bulk-print', {
    title: 'Print Name Tags',
    badges,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
  });
});

router.post('/print-barcodes', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT id, name, barcode FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  res.render('main-admin-name-tag-barcode-print', {
    title: 'Print Barcodes',
    members,
  });
});

module.exports = router;

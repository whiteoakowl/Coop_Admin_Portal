// Name Tags / Design & Print, mirrored into Main Admin - a real request:
// "design and print on co-op admin portal should be exactly the same
// under name tags under main admin portal." Started as a smaller "name
// tags only" mirror (see the git history on this file / task #207); this
// pass brings it up to the SAME full feature set as Co-op Admin's own
// Design/Print hub (routes/admin-design.js + admin-name-tag.js +
// admin-schedule.js's schedule-card design/print routes + admin-misc-
// badges.js) - Schedule Cards, Setup/Cleanup badges, Custom badges,
// combined/duplex printing, the Avery mailing-label sheet, Class Check-In
// QR codes, Playground QR codes, Library Barcodes, and the Name Tag
// Requests queue (archive + CSV export), not just name tag design + bulk
// print.
//
// Deliberately still NOT a fork of any of that logic - every helper
// below is the exact same shared utils/* module Co-op Admin's own routes
// use (nameTagData/nameTagBadge, scheduleCardData/scheduleCardBadge,
// miscBadgeData, duplexPrint, cardPairs, library, playground, classSchedule,
// schedule, spreadsheet, designImageGC) against the exact same tables -
// a template or badge saved from either portal is the same one, not two
// drifting copies. Only the route wiring/auth gate (Main Admin's
// requirePortalPermission instead of Co-op Admin's requireFullAdmin) and
// the views (Main Admin's own portal-nav instead of admin-nav) are new.
//
// One deliberate scope cut: Co-op Admin's own Design/Print page also
// bundles "Print Schedules" (links to the Class Schedule grid print and
// Member Schedules List) and "Print Logs" (links to the Absence/Check-
// in-out/Name Tag Request logs) sections onto its Print tab. Those aren't
// name-tag/badge design or print jobs at all - they're plain links out
// to Co-op Admin's own Class Schedule and Logs pages, which don't exist
// under Main Admin's own URL namespace (and are gated behind Co-op
// Admin's own separate admin session, not a Main Admin one) - bringing
// them "over" would mean building two entire unrelated subsystems from
// scratch, not extending this page. Left out; everything else Design/
// Print actually designs or prints is here.
//
// Unlike Co-op Admin's own split across 4 separate route files, this
// stays ONE file/page (matching how this file already worked before this
// pass) - Main Admin's nav has always treated "Name Tags" as a single
// destination, not four.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMembers } = require('../utils/nameTagData');
const {
  CARD_WIDTH,
  CARD_HEIGHT,
  FIELDS,
  TABLE_FIELDS,
  SHAPE_TYPES: CARD_SHAPE_TYPES,
  FONT_FAMILIES: CARD_FONT_FAMILIES,
  DEFAULT_LAYOUT,
} = require('../utils/scheduleCardBadge');
const { getScheduleCardTemplate, scheduleCardDataForMembers } = require('../utils/scheduleCardData');
const {
  isMiscBadgeType,
  getMiscTemplate,
  saveMiscTemplate,
  listMiscBadges,
  getSetupCleanupBypassBadge,
  replaceMiscBadges,
  deleteMiscBadge,
  miscBadgeRowData,
} = require('../utils/miscBadgeData');
const { imageFileFilter, spreadsheetFileFilter } = require('../utils/uploads');
const { sweepNameTagImages, sweepScheduleCardImages } = require('../utils/designImageGC');
const { createStorageClient, publicUrl } = require('../utils/storage');
const { saveUpload } = require('../utils/uploadBackend');
const { jsonScriptSafe } = require('../utils/json');
const { byLastName, membersWithDetails, allFamilies } = require('../utils/members');
const { buildDuplexPages, SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { buildCardPairs } = require('../utils/cardPairs');
const { formatDateLabel, formatTimestamp } = require('../utils/dates');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const { paginate, parsePage, parsePageSize, DEFAULT_PAGE_SIZE } = require('../utils/pagination');
const { allClassesList, UNASSIGNED_ROOM, HOUR_POSITIONS } = require('../utils/classSchedule');
const { DAYS, DAY_LABELS } = require('../utils/days');
const { playgroundHourLabel } = require('../utils/playground');
const { allItems: allLibraryItems, allLibraryTypes } = require('../utils/library');
const { schedulesForMembers } = require('../utils/schedule');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_name_tags'));

const NAME_TAG_TYPES = ['student', 'parent', 'admin'];
const DESIGN_TYPES = ['student', 'parent', 'admin', 'scheduleCard', 'setupCleanup', 'custom'];
const TABS = ['design', 'print', 'requests'];
const BADGE_TYPE_LABELS = { setupCleanup: 'Setup/Cleanup', custom: 'Custom' };

const REQUEST_TYPE_LABELS = { new_tag: 'New Name Tag', lost_tag: 'Lost Name Tag', schedule_change: 'Schedule Change' };
const NAME_TAG_DAY_LABELS = { monday: 'Monday', wednesday: 'Wednesday', both: 'Both' };

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'name-tags');
const NAME_TAG_IMAGES_BUCKET = 'name-tag-images';
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(DESIGN_IMAGE_DIR)) fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });

// Schedule Card design images get their own bucket/dir (same split as
// Co-op Admin's own admin-schedule.js vs admin-name-tag.js), but since
// this page's schedule-card-editor.js is parameterized with its own
// basePath under a '/schedule-card' sub-path (see the scheduleCardDataJson
// seed below) rather than a whole separate mount the way Co-op Admin has
// it, its two routes live down at the bottom of this file instead of a
// second router file.
const SCHEDULE_CARD_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'schedule-cards');
const SCHEDULE_CARD_IMAGES_BUCKET = 'schedule-card-images';
if (!storageClient && !fs.existsSync(SCHEDULE_CARD_IMAGE_DIR)) fs.mkdirSync(SCHEDULE_CARD_IMAGE_DIR, { recursive: true });

const uploadDesignImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});
const uploadMiscImport = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

// Name Tag Requests - same underlying name_tag_requests table Co-op
// Admin's own Logs tab and Design/Print Requests tab both already read
// (see routes/admin-design.js's own comment on why this duplicates that
// query rather than sharing one function across route files).
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

router.get('/', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'design';
  const initialType = DESIGN_TYPES.includes(req.query.type) ? req.query.type : 'student';

  const members = (await membersWithDetails()).filter((m) => m.active);

  const classesForQr = await allClassesList();
  const qrRoomOptions = [...new Set(classesForQr.map((c) => c.room).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  const dateFilter = req.query.date || '';
  const showArchived = req.query.archived === '1';
  const allSubmissions = (await nameTagSubmissions(showArchived, dateFilter)).map((r) => ({
    id: r.id,
    timestamp: formatTimestamp(r.createdAt),
    memberName: r.memberName,
    requestTypeLabel: REQUEST_TYPE_LABELS[r.requestType] || r.requestType,
    dayLabel: NAME_TAG_DAY_LABELS[r.day] || r.day,
    description: r.description || '—',
  }));
  const requestDates = (
    await db.prepare(`SELECT DISTINCT date(created_at)::text AS d FROM name_tag_requests WHERE archived = ? ORDER BY d DESC`).all(showArchived ? 1 : 0)
  ).map((r) => ({ date: r.d, label: formatDateLabel(r.d) }));
  const requestsPageSize = parsePageSize(req.query.pageSize, DEFAULT_PAGE_SIZE);
  const requestsPagination = paginate(allSubmissions, parsePage(req.query.page), requestsPageSize);

  res.render('main-admin-name-tags', {
    title: 'Name Tags',
    tab,
    initialType,
    members,
    // A real request: "all bulk printing should have filter by family
    // name" - every member-based Print tab panel below gets its own
    // Family Name filter select (views/partials/family-filter-select.ejs)
    // built from this same list.
    families: await allFamilies(),
    classesForQr,
    qrRoomOptions,
    libraryItems: await allLibraryItems(),
    libraryTypes: await allLibraryTypes(),
    error: req.query.error || null,
    initialPrintPanel: ['setupCleanupBadges', 'customBadges', 'bypassBadge'].includes(req.query.print) ? req.query.print : null,
    notice: req.query.notice || null,
    // A real request: "make bypass setup/cleanup cards it's own selection
    // for bulk printing in the dropdown menu" - it gets its own dedicated
    // print panel now, so it's filtered out of the regular Setup/Cleanup
    // Badges checklist here instead of showing up twice.
    setupCleanupBadges: (await listMiscBadges('setupCleanup')).filter((b) => b.task_item_id != null),
    bypassBadge: await getSetupCleanupBypassBadge(),
    customBadges: await listMiscBadges('custom'),
    submissions: requestsPagination.items,
    allSubmissions,
    pagination: requestsPagination,
    viewingAll: requestsPageSize === Infinity,
    baseHref: `/main-admin/name-tags?tab=requests${showArchived ? '&archived=1' : ''}${dateFilter ? `&date=${encodeURIComponent(dateFilter)}` : ''}&`,
    dates: requestDates,
    dateFilter,
    showArchived,
    nameTagDataJson: jsonScriptSafe({
      basePath: '/main-admin/name-tags',
      templates: {
        student: await getTemplate('student'),
        parent: await getTemplate('parent'),
        admin: await getTemplate('admin'),
        setupCleanup: await getMiscTemplate('setupCleanup'),
        custom: await getMiscTemplate('custom'),
      },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
    scheduleCardDataJson: jsonScriptSafe({
      // Its own sub-path, not '/main-admin/name-tags' bare - the name tag
      // editor's own basePath already claims that exact prefix for its
      // /design-image and /template/:type routes; without a distinct
      // prefix the schedule card editor's image upload would collide
      // with the name tag editor's own (see this file's own top comment).
      basePath: '/main-admin/name-tags/schedule-card',
      template: await getScheduleCardTemplate(),
      defaultLayout: DEFAULT_LAYOUT,
      fields: FIELDS,
      tableFields: TABLE_FIELDS,
      shapeTypes: CARD_SHAPE_TYPES,
      fontFamilies: CARD_FONT_FAMILIES,
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
    }),
  });
});

router.get('/requests/export.csv', async (req, res) => {
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
        NAME_TAG_DAY_LABELS[r.day] || r.day,
        r.description || '',
      ])
    ),
  ];
  sendCsv(res, `name-tag-${showArchived ? 'archived' : 'requests'}.csv`, lines);
});

router.post('/requests/:id/archive', async (req, res) => {
  await db.prepare('UPDATE name_tag_requests SET archived = 1 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/main-admin/name-tags?tab=requests');
});

router.post('/requests/:id/unarchive', async (req, res) => {
  await db.prepare('UPDATE name_tag_requests SET archived = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.redirect('/main-admin/name-tags?tab=requests&archived=1');
});

// Shared by the Student/Parent/Admin name tag types AND the Setup/Cleanup
// and Custom badge types (they all use the same editor, name-tag-
// editor.js) - member-type name tags persist to name_tag_templates,
// misc badge types to their own misc_badge_templates table. Same
// combined handling as routes/admin-name-tag.js's own /name-tag/template/
// :type.
router.post('/template/:type', async (req, res) => {
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

// ---------------------------------------------------------------------
// Schedule Card design (public/js/schedule-card-editor.js, basePath
// '/main-admin/name-tags/schedule-card' - see this file's own top comment)
// ---------------------------------------------------------------------

router.post('/schedule-card/design/template', async (req, res) => {
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
      `INSERT INTO schedule_card_templates (id, layout_json, updated_at) VALUES (1, ?, now_text())
       ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = now_text()`
    )
    .run(JSON.stringify(layout));
  await sweepScheduleCardImages();

  res.json({ ok: true });
});

router.post('/schedule-card/design-image', uploadDesignImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  const key = await saveUpload({
    client: storageClient,
    bucket: SCHEDULE_CARD_IMAGES_BUCKET,
    localDir: SCHEDULE_CARD_IMAGE_DIR,
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    contentType: req.file.mimetype,
  });
  const url = storageClient ? publicUrl(SCHEDULE_CARD_IMAGES_BUCKET, key) : `/uploads/schedule-cards/${key}`;
  res.json({ ok: true, url });
});

// ---------------------------------------------------------------------
// Print - name tags
// ---------------------------------------------------------------------

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

router.post('/print-plain-parent', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders}) AND member_type = 'parent'`).all(...memberIds)).sort(byLastName);
  if (members.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one parent to print a plain parent tag.'));
  }

  const template = await getTemplate('parent');
  const plainElements = template.elements.filter((el) => el.field !== 'setupCleanupDays');
  const dataByMember = await badgeDataForMembers(members);
  const badges = members.map((m) => ({
    html: NameTagRenderCore.renderBadgeElements(plainElements, dataByMember[m.id]),
    bgCss: NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity),
  }));

  res.render('main-admin-name-tag-bulk-print', {
    title: 'Print Plain Parent Name Tags',
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

router.post('/print-barcode-labels', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (
    await db.prepare(`SELECT id, name, barcode, member_code FROM members WHERE id IN (${placeholders})`).all(...memberIds)
  ).sort(byLastName);

  res.render('main-admin-name-tag-barcode-labels-print', {
    title: 'Print Barcode Labels',
    members,
  });
});

// ---------------------------------------------------------------------
// Print - schedule cards, combined, duplex
// ---------------------------------------------------------------------

router.post('/print-cards', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const template = await getScheduleCardTemplate();
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const scheduleByMember = await schedulesForMembers(members.map((m) => m.id));
  const cardDataByMember = await scheduleCardDataForMembers(members, scheduleByMember);
  const cards = members.map((m) => ({
    html: NameTagRenderCore.renderBadgeElements(template.elements, cardDataByMember[m.id]),
    bgCss,
  }));

  res.render('main-admin-schedule-print-cards', {
    title: 'Print Schedule Cards',
    cards,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

router.post('/print-both', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  res.render('main-admin-name-tag-both-print', {
    title: 'Print Name Tags + Schedule Cards',
    pairs: await buildCardPairs(members),
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

router.post('/print-duplex', async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const { frontPages, backPages } = buildDuplexPages(await buildCardPairs(members));

  res.render('main-admin-cards-duplex-print', {
    title: 'Print Name Tags + Schedule Cards (Front & Back)',
    frontPages,
    backPages,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

// ---------------------------------------------------------------------
// Setup/Cleanup + Custom badges (utils/miscBadgeData.js)
// ---------------------------------------------------------------------

function requireMiscBadgeType(req, res, next) {
  if (!isMiscBadgeType(req.params.type)) return res.status(404).send('Not found');
  next();
}

router.get('/badges/:type/import-template.xlsx', requireMiscBadgeType, (req, res) => {
  const buffer = buildTemplateWorkbook(
    ['Badge Number', 'Title', 'Description'],
    [
      ['1', 'Snack Table', 'Set up the snack table and chairs before 9am.'],
      ['2', 'Front Entrance', 'Sweep and tidy the front entrance after co-op.'],
    ]
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-badges-import-template.xlsx"`);
  res.send(buffer);
});

const MISC_IMPORT_ALIASES = {
  badgeNumber: ['badge number', 'badge #', 'number', '#'],
  title: ['title', 'name'],
  description: ['description', 'notes'],
};

function normalizeMiscImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const out = {};
  for (const [field, aliases] of Object.entries(MISC_IMPORT_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] !== undefined && String(lowerMap[alias]).trim() !== '') {
        out[field] = String(lowerMap[alias]).trim();
        break;
      }
    }
  }
  return out;
}

router.post('/badges/:type/import', requireMiscBadgeType, uploadMiscImport.single('file'), async (req, res) => {
  const type = req.params.type;
  if (type === 'setupCleanup') {
    return res.redirect(
      '/main-admin/name-tags?tab=print&error=' + encodeURIComponent("Setup/Cleanup badges are created automatically from the Task List and can't be imported.")
    );
  }
  if (!req.file) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeMiscImportRow).filter((r) => r.title || r.badgeNumber);
  } catch (err) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  await replaceMiscBadges(type, rows);
  res.redirect(`/main-admin/name-tags?tab=print&print=${type}Badges&notice=` + encodeURIComponent(`Imported ${rows.length} ${BADGE_TYPE_LABELS[type]} badge(s).`));
});

router.post('/badges/:type/delete/:id', requireMiscBadgeType, async (req, res) => {
  await deleteMiscBadge(parseInt(req.params.id, 10));
  res.redirect(`/main-admin/name-tags?tab=print&print=${req.params.type}Badges`);
});

// A real request: "make bypass setup/cleanup cards it's own selection
// for bulk printing in the dropdown menu. it should print 8 cards to a
// sheet. same size as the name tags and schedule cards." Same reasoning
// and shape as routes/admin-misc-badges.js's own /design/badges/bypass/
// print - registered before the generic /badges/:type/print below for
// the same "literal path before :param" reason (there's no real
// 'bypass' misc badge type, so requireMiscBadgeType would 404 it first).
router.post('/badges/bypass/print', async (req, res) => {
  const bypass = await getSetupCleanupBypassBadge();
  if (!bypass) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('No Setup/Cleanup bypass badge found.'));
  }
  const quantity = Math.min(50, Math.max(1, parseInt(req.body.quantity, 10) || 1));

  const template = await getMiscTemplate('setupCleanup');
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const html = NameTagRenderCore.renderBadgeElements(template.elements, miscBadgeRowData(bypass));
  const cards = Array.from({ length: quantity }, () => ({ html, bgCss }));

  res.render('main-admin-misc-badges-print', {
    title: 'Print Setup/Cleanup Bypass Badges',
    cards,
    cardWidth: BADGE_WIDTH,
    cardHeight: BADGE_HEIGHT,
  });
});

router.post('/badges/:type/print', requireMiscBadgeType, async (req, res) => {
  const type = req.params.type;
  const requestedIds = [].concat(req.body.badgeIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const all = await listMiscBadges(type);
  const rows = requestedIds.length > 0 ? all.filter((r) => requestedIds.includes(r.id)) : all;

  if (rows.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one badge to print.'));
  }

  const template = await getMiscTemplate(type);
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const cards = rows.map((row) => ({
    html: NameTagRenderCore.renderBadgeElements(template.elements, miscBadgeRowData(row)),
    bgCss,
  }));

  res.render('main-admin-misc-badges-print', {
    title: `Print ${BADGE_TYPE_LABELS[type]} Badges`,
    cards,
    cardWidth: BADGE_WIDTH,
    cardHeight: BADGE_HEIGHT,
  });
});

// ---------------------------------------------------------------------
// QR codes + library barcodes
// ---------------------------------------------------------------------

router.post('/print-classcheckin-qr', async (req, res) => {
  const classIds = [].concat(req.body.classIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (classIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one class to print.'));
  }

  const allClasses = await allClassesList();
  const idSet = new Set(classIds);
  const classes = allClasses.filter((c) => idSet.has(c.id));

  const origin = `${req.protocol}://${req.get('host')}`;
  const groups = new Map();
  for (const c of classes) {
    const room = c.room && c.room.trim() ? c.room.trim() : UNASSIGNED_ROOM;
    const key = `${c.day}|${room}`;
    if (!groups.has(key)) groups.set(key, { day: c.day, dayLabel: c.dayLabel, room, classes: [] });
    groups.get(key).classes.push(c);
  }

  const pages = Array.from(groups.values())
    .sort((a, b) => a.day.localeCompare(b.day) || a.room.localeCompare(b.room))
    .map((g) => ({
      dayLabel: g.dayLabel,
      room: g.room,
      classes: g.classes
        .sort((a, b) => a.hour_position - b.hour_position)
        .map((c) => ({
          className: c.class_name,
          dayLabel: c.dayLabel,
          timeLabel: c.timeLabel,
          checkInUrl: `${origin}/kiosk/class-checkin/classes/${c.id}/attendance`,
        })),
    }));

  res.render('main-admin-classcheckin-qr-print', {
    title: 'Print Class Check-In QR Codes',
    pages,
  });
});

router.get('/print-playground-qr', async (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const pages = [];
  for (const day of DAYS) {
    const hours = [];
    for (const hour of HOUR_POSITIONS) {
      hours.push({
        hourLabel: await playgroundHourLabel(day, hour),
        checkInUrl: `${origin}/kiosk/class-checkin/playground/${day}/${hour}/attendance`,
      });
    }
    pages.push({ dayLabel: DAY_LABELS[day], hours });
  }

  res.render('main-admin-playground-qr-print', {
    title: 'Print Playground Check-In QR Codes',
    pages,
  });
});

router.post('/print-library-barcodes', async (req, res) => {
  const itemIds = [].concat(req.body.itemIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (itemIds.length === 0) {
    return res.redirect('/main-admin/name-tags?tab=print&error=' + encodeURIComponent('Select at least one library item to print.'));
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const items = (await db.prepare(`SELECT * FROM library_items WHERE id IN (${placeholders})`).all(...itemIds)).sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );

  res.render('main-admin-library-barcodes-print', {
    title: 'Print Library Barcodes',
    items,
  });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const multer = require('multer');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const {
  isMiscBadgeType,
  getMiscTemplate,
  listMiscBadges,
  getSetupCleanupBypassBadge,
  replaceMiscBadges,
  deleteMiscBadge,
  miscBadgeRowData,
} = require('../utils/miscBadgeData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

router.use(requireFullAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

const BADGE_TYPE_LABELS = { setupCleanup: 'Setup/Cleanup', custom: 'Custom' };

function requireMiscBadgeType(req, res, next) {
  if (!isMiscBadgeType(req.params.type)) return res.status(404).send('Not found');
  next();
}

router.get('/design/badges/:type/import-template.xlsx', requireMiscBadgeType, (req, res) => {
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

const IMPORT_ALIASES = {
  badgeNumber: ['badge number', 'badge #', 'number', '#'],
  title: ['title', 'name'],
  description: ['description', 'notes'],
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

// An import defines the full deck for this badge type - it replaces
// whatever list was there before rather than appending to it. Not
// available for 'setupCleanup' (server-side, not just the hidden UI -
// see partials/misc-badge-print-panel.ejs's own comment) - those badges
// are auto-created from the Task List now, and replaceMiscBadges'
// delete-everything-then-reinsert would both orphan every task's own
// task_item_id link and desync the badges from what the Task List
// actually contains.
router.post('/design/badges/:type/import', requireMiscBadgeType, upload.single('file'), async (req, res) => {
  const type = req.params.type;
  if (type === 'setupCleanup') {
    return res.redirect(
      '/admin/design?tab=print&error=' + encodeURIComponent('Setup/Cleanup badges are created automatically from the Task List and can\'t be imported.')
    );
  }
  if (!req.file) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeImportRow).filter((r) => r.title || r.badgeNumber);
  } catch (err) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  await replaceMiscBadges(type, rows);
  res.redirect(`/admin/design?tab=print&print=${type}Badges&notice=` + encodeURIComponent(`Imported ${rows.length} ${BADGE_TYPE_LABELS[type]} badge(s).`));
});

router.post('/design/badges/:type/delete/:id', requireMiscBadgeType, async (req, res) => {
  await deleteMiscBadge(parseInt(req.params.id, 10));
  res.redirect(`/admin/design?tab=print&print=${req.params.type}Badges`);
});

// A real request: "make bypass setup/cleanup cards it's own selection
// for bulk printing in the dropdown menu. it should print 8 cards to a
// sheet. same size as the name tags and schedule cards." The bypass
// badge (db/bootstrapPg.js's seedIfMissing) used to be just one row
// mixed into the regular Setup/Cleanup Badges checklist below alongside
// every real task's own badge - unlike those, an admin doesn't want to
// pick it from a list, they want N physical copies to keep on hand at
// checkout, so this is a quantity form instead. Registered before the
// generic /design/badges/:type/print below - "bypass" would otherwise
// match THAT route's own :type param (there's no real 'bypass' misc
// badge type) and 404 via requireMiscBadgeType before ever reaching
// this one, same "literal path before :param" rule this app's route
// files keep re-learning. Renders the exact same admin-misc-badges-print
// view every other misc badge already prints through - same 8-per-page
// .badge-sheet grid, same card size, nothing new needed there.
router.post('/design/badges/bypass/print', async (req, res) => {
  const bypass = await getSetupCleanupBypassBadge();
  if (!bypass) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('No Setup/Cleanup bypass badge found.'));
  }
  const quantity = Math.min(50, Math.max(1, parseInt(req.body.quantity, 10) || 1));

  const template = await getMiscTemplate('setupCleanup');
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const html = NameTagRenderCore.renderBadgeElements(template.elements, miscBadgeRowData(bypass));
  const cards = Array.from({ length: quantity }, () => ({ html, bgCss }));

  res.render('admin-misc-badges-print', {
    title: 'Print Setup/Cleanup Bypass Badges',
    cards,
    cardWidth: BADGE_WIDTH,
    cardHeight: BADGE_HEIGHT,
  });
});

router.post('/design/badges/:type/print', requireMiscBadgeType, async (req, res) => {
  const type = req.params.type;
  const requestedIds = [].concat(req.body.badgeIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const all = await listMiscBadges(type);
  const rows = requestedIds.length > 0 ? all.filter((r) => requestedIds.includes(r.id)) : all;

  if (rows.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one badge to print.'));
  }

  const template = await getMiscTemplate(type);
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  const cards = rows.map((row) => ({
    html: NameTagRenderCore.renderBadgeElements(template.elements, miscBadgeRowData(row)),
    bgCss,
  }));

  res.render('admin-misc-badges-print', {
    title: `Print ${BADGE_TYPE_LABELS[type]} Badges`,
    cards,
    cardWidth: BADGE_WIDTH,
    cardHeight: BADGE_HEIGHT,
  });
});

module.exports = router;

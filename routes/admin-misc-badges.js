const express = require('express');
const router = express.Router();
const multer = require('multer');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { BADGE_WIDTH, BADGE_HEIGHT } = require('../utils/nameTagBadge');
const { isMiscBadgeType, getMiscTemplate, listMiscBadges, replaceMiscBadges, deleteMiscBadge, miscBadgeRowData } = require('../utils/miscBadgeData');
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
// whatever list was there before rather than appending to it.
router.post('/design/badges/:type/import', requireMiscBadgeType, upload.single('file'), (req, res) => {
  const type = req.params.type;
  if (!req.file) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = readRowsFromFile(req.file.buffer).map(normalizeImportRow).filter((r) => r.title || r.badgeNumber);
  } catch (err) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  replaceMiscBadges(type, rows);
  res.redirect(`/admin/design?tab=print&print=${type}Badges&notice=` + encodeURIComponent(`Imported ${rows.length} ${BADGE_TYPE_LABELS[type]} badge(s).`));
});

router.post('/design/badges/:type/delete/:id', requireMiscBadgeType, (req, res) => {
  deleteMiscBadge(parseInt(req.params.id, 10));
  res.redirect(`/admin/design?tab=print&print=${req.params.type}Badges`);
});

router.post('/design/badges/:type/print', requireMiscBadgeType, (req, res) => {
  const type = req.params.type;
  const requestedIds = [].concat(req.body.badgeIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  const all = listMiscBadges(type);
  const rows = requestedIds.length > 0 ? all.filter((r) => requestedIds.includes(r.id)) : all;

  if (rows.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one badge to print.'));
  }

  const template = getMiscTemplate(type);
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

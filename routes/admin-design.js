const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate, badgeDataForMember } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES: CARD_SHAPE_TYPES, FONT_FAMILIES: CARD_FONT_FAMILIES, DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');
const { getScheduleCardTemplate, scheduleCardDataForMember } = require('../utils/scheduleCardData');
const { getMiscTemplate, listMiscBadges } = require('../utils/miscBadgeData');
const { jsonScriptSafe } = require('../utils/json');
const { membersWithDetails } = require('../utils/members');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

router.use(requireFullAdmin);

const DESIGN_TYPES = ['student', 'parent', 'scheduleCard', 'setupCleanup', 'custom'];
const TABS = ['design', 'print'];

// Unified Design/Print page: Design has one dropdown (Student/Parent/Admin
// Name Tag, or Schedule Card) instead of separate Name Tag and Schedule
// Card design pages. Both canvas editors render into the same page and
// toggle with plain show/hide - each keeps its own untouched engine
// (name-tag-editor.js / schedule-card-editor.js), so switching types never
// reloads the page. Print has a dropdown of what to print (schedule cards,
// name tags, schedules, logs), reusing the existing print flows for each.
router.get('/design', requireAdmin, (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'design';
  const initialType = DESIGN_TYPES.includes(req.query.type) ? req.query.type : 'student';

  // Same photo/type/family/rosters shape as the Members page's own table -
  // the Print tab's bulk picker lists are meant to look and read like that
  // list (just with a selection checkbox instead of Actions), not a bare
  // name-only table.
  const members = membersWithDetails().filter((m) => m.active);

  res.render('admin-design', {
    title: 'Design / Print',
    tab,
    initialType,
    members,
    error: req.query.error || null,
    initialPrintPanel: ['setupCleanupBadges', 'customBadges'].includes(req.query.print) ? req.query.print : null,
    notice: req.query.notice || null,
    setupCleanupBadges: listMiscBadges('setupCleanup'),
    customBadges: listMiscBadges('custom'),
    nameTagDataJson: jsonScriptSafe({
      templates: {
        student: getTemplate('student'),
        parent: getTemplate('parent'),
        setupCleanup: getMiscTemplate('setupCleanup'),
        custom: getMiscTemplate('custom'),
      },
      defaultLayouts: DEFAULT_LAYOUTS,
      fieldsByType: FIELDS_BY_TYPE,
      shapeTypes: SHAPE_TYPES,
      fontFamilies: FONT_FAMILIES,
      badgeWidth: BADGE_WIDTH,
      badgeHeight: BADGE_HEIGHT,
    }),
    scheduleCardDataJson: jsonScriptSafe({
      template: getScheduleCardTemplate(),
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

// Bulk "Name Tags + Schedule Cards" print: each selected member's two
// cards side by side, one row per member - unlike the separate bulk Name
// Tag / Schedule Card sheets (8-per-page grids of one card type), this is
// a comparison/cut-together layout, so it isn't pinned to that grid.
router.post('/design/print-both', requireFullAdmin, (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = db.prepare(`SELECT * FROM members WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`).all(...memberIds);

  const nameTagTemplates = { student: getTemplate('student'), parent: getTemplate('parent') };
  const scheduleCardTemplate = getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  const pairs = members.map((m) => {
    const nameTagLayout = nameTagTemplates[m.member_type] || nameTagTemplates.student;
    return {
      name: m.name,
      nameTag: {
        html: NameTagRenderCore.renderBadgeElements(nameTagLayout.elements, badgeDataForMember(m)),
        bgCss: NameTagRenderCore.backgroundCss(nameTagLayout.background, nameTagLayout.backgroundOpacity),
      },
      scheduleCard: {
        html: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, scheduleCardDataForMember(m)),
        bgCss: scheduleCardBgCss,
      },
    };
  });

  res.render('admin-name-tag-both-print', {
    title: 'Print Name Tags + Schedule Cards',
    pairs,
    badgeWidth: BADGE_WIDTH,
    badgeHeight: BADGE_HEIGHT,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
  });
});

module.exports = router;

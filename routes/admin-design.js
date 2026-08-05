const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { BADGE_WIDTH, BADGE_HEIGHT, FIELDS_BY_TYPE, SHAPE_TYPES, FONT_FAMILIES, DEFAULT_LAYOUTS } = require('../utils/nameTagBadge');
const { getTemplate } = require('../utils/nameTagData');
const { CARD_WIDTH, CARD_HEIGHT, FIELDS, TABLE_FIELDS, SHAPE_TYPES: CARD_SHAPE_TYPES, FONT_FAMILIES: CARD_FONT_FAMILIES, DEFAULT_LAYOUT } = require('../utils/scheduleCardBadge');
const { getScheduleCardTemplate } = require('../utils/scheduleCardData');
const { jsonScriptSafe } = require('../utils/json');

const DESIGN_TYPES = ['student', 'parent', 'admin', 'scheduleCard'];
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

  const members = db
    .prepare('SELECT id, name, member_type FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE')
    .all();

  res.render('admin-design', {
    title: 'Design / Print',
    tab,
    initialType,
    members,
    error: req.query.error || null,
    nameTagDataJson: jsonScriptSafe({
      templates: { student: getTemplate('student'), parent: getTemplate('parent'), admin: getTemplate('admin') },
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

module.exports = router;

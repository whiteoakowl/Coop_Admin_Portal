// DB-backed lookups for the two "misc badge" types (Setup/Cleanup, Custom/
// Miscellaneous) - mirrors utils/nameTagData.js, but each badge is one row
// of an admin-imported list rather than a member. Kept in its own table
// (misc_badge_templates/misc_badges) so name_tag_templates' member-only
// shape stays untouched.
const db = require('../db');
const { DEFAULT_LAYOUTS } = require('./nameTagBadge');

const MISC_BADGE_TYPES = ['setupCleanup', 'custom'];

function isMiscBadgeType(type) {
  return MISC_BADGE_TYPES.includes(type);
}

function getMiscTemplate(badgeType) {
  const row = db.prepare('SELECT layout_json FROM misc_badge_templates WHERE badge_type = ?').get(badgeType);
  if (!row) return DEFAULT_LAYOUTS[badgeType];
  try {
    return JSON.parse(row.layout_json);
  } catch (err) {
    return DEFAULT_LAYOUTS[badgeType];
  }
}

function saveMiscTemplate(badgeType, layout) {
  db.prepare(
    `INSERT INTO misc_badge_templates (badge_type, layout_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(badge_type) DO UPDATE SET layout_json = excluded.layout_json, updated_at = datetime('now')`
  ).run(badgeType, JSON.stringify(layout));
}

function listMiscBadges(badgeType) {
  return db
    .prepare('SELECT * FROM misc_badges WHERE badge_type = ? ORDER BY badge_number COLLATE NOCASE, id')
    .all(badgeType);
}

function getMiscBadge(id) {
  return db.prepare('SELECT * FROM misc_badges WHERE id = ?').get(id);
}

// An import always defines the full deck for that badge type, so it
// replaces whatever list was there before rather than appending to it.
function replaceMiscBadges(badgeType, rows) {
  db.prepare('DELETE FROM misc_badges WHERE badge_type = ?').run(badgeType);
  const insert = db.prepare('INSERT INTO misc_badges (badge_type, badge_number, title, description) VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(badgeType, row.badgeNumber || null, row.title || null, row.description || null);
}

function deleteMiscBadge(id) {
  db.prepare('DELETE FROM misc_badges WHERE id = ?').run(id);
}

// The field values a misc badge template can place on one row's card.
function miscBadgeRowData(row) {
  return { badgeNumber: row.badge_number || '', title: row.title || '', description: row.description || '' };
}

module.exports = {
  MISC_BADGE_TYPES,
  isMiscBadgeType,
  getMiscTemplate,
  saveMiscTemplate,
  listMiscBadges,
  getMiscBadge,
  replaceMiscBadges,
  deleteMiscBadge,
  miscBadgeRowData,
};

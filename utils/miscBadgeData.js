// DB-backed lookups for the two "misc badge" types (Setup/Cleanup, Custom/
// Miscellaneous) - mirrors utils/nameTagData.js, but each badge is one row
// of an admin-imported list rather than a member. Kept in its own table
// (misc_badge_templates/misc_badges) so name_tag_templates' member-only
// shape stays untouched.
const db = require('../db');
const { DEFAULT_LAYOUTS } = require('./nameTagBadge');
const { DAY_LABELS } = require('./days');

const MISC_BADGE_TYPES = ['setupCleanup', 'custom'];

function isMiscBadgeType(type) {
  return MISC_BADGE_TYPES.includes(type);
}

async function getMiscTemplate(badgeType) {
  const row = await db.prepare('SELECT layout_json FROM misc_badge_templates WHERE badge_type = ?').get(badgeType);
  if (!row) return DEFAULT_LAYOUTS[badgeType];
  try {
    return JSON.parse(row.layout_json);
  } catch (err) {
    return DEFAULT_LAYOUTS[badgeType];
  }
}

async function saveMiscTemplate(badgeType, layout) {
  await db.prepare(
    `INSERT INTO misc_badge_templates (badge_type, layout_json, updated_at) VALUES (?, ?, now_text())
     ON CONFLICT(badge_type) DO UPDATE SET layout_json = excluded.layout_json, updated_at = now_text()`
  ).run(badgeType, JSON.stringify(layout));
}

async function listMiscBadges(badgeType) {
  return db
    .prepare('SELECT * FROM misc_badges WHERE badge_type = ? ORDER BY LOWER(badge_number), id')
    .all(badgeType);
}

async function getMiscBadge(id) {
  return db.prepare('SELECT * FROM misc_badges WHERE id = ?').get(id);
}

// The one 'setupCleanup' row with no task_item_id - db/bootstrapPg.js's
// seedIfMissing own comment explains why that's a safe, unambiguous
// marker for it. A real request: "make bypass setup/cleanup cards it's
// own selection for bulk printing in the dropdown menu" - this is what
// that dedicated print flow (routes/admin-misc-badges.js) looks it up
// by, instead of it being just one row mixed into the regular Setup/
// Cleanup Badges checklist alongside every real task's own badge.
async function getSetupCleanupBypassBadge() {
  return db.prepare("SELECT * FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL").get();
}

// An import always defines the full deck for that badge type, so it
// replaces whatever list was there before rather than appending to it.
async function replaceMiscBadges(badgeType, rows) {
  await db.prepare('DELETE FROM misc_badges WHERE badge_type = ?').run(badgeType);
  const insert = db.prepare('INSERT INTO misc_badges (badge_type, badge_number, title, description) VALUES (?, ?, ?, ?)');
  for (const row of rows) await insert.run(badgeType, row.badgeNumber || null, row.title || null, row.description || null);
}

async function deleteMiscBadge(id) {
  await db.prepare('DELETE FROM misc_badges WHERE id = ?').run(id);
}

// The field values a misc badge template can place on one row's card.
// barcodeValue is only ever set on a 'setupCleanup' row (see misc_badges'
// own task_item_id schema comment) - always empty for 'custom', which has
// no barcode element on its default layout and isn't meant to be scanned.
// day/leaderLabel are the same - only ever populated for 'setupCleanup'
// rows (utils/taskList.js's upsertTaskBadge); a 'custom' row's own day/
// leader_name columns are always null, so both come back blank here,
// which is exactly right since the default 'custom' layout has no
// elements bound to either field anyway.
function miscBadgeRowData(row) {
  return {
    badgeNumber: row.badge_number || '',
    title: row.title || '',
    description: row.description || '',
    barcodeValue: row.barcode || '',
    day: row.day ? DAY_LABELS[row.day] || row.day : '',
    leaderLabel: row.leader_name ? `Leader: ${row.leader_name}` : '',
  };
}

module.exports = {
  MISC_BADGE_TYPES,
  isMiscBadgeType,
  getMiscTemplate,
  saveMiscTemplate,
  listMiscBadges,
  getMiscBadge,
  getSetupCleanupBypassBadge,
  replaceMiscBadges,
  deleteMiscBadge,
  miscBadgeRowData,
};

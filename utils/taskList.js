const db = require('../db');

// Every task's own permanent 6-digit code, assigned once at creation and
// never touched again - mirrors utils/members.js's generateMemberCode
// exactly, same reasoning (fixed length so the printed barcode is
// predictable). Checked against task_list_items.barcode specifically,
// not members.barcode - a task's code and a member's code sharing the
// same numeric value is harmless, since the checkout flow scans each
// against its own table in its own step (member first, then task), never
// searching both at once.
async function generateTaskCode() {
  const exists = db.prepare('SELECT 1 FROM task_list_items WHERE barcode = ?');
  let code;
  do {
    code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  } while (await exists.get(code));
  return code;
}

// Creates (or, on an update, keeps in sync) this task's own printable
// Setup/Cleanup badge - see misc_badges.task_item_id's own schema
// comment on why these are no longer a separately admin-imported deck.
// A real bug report: "The only information that should be included on
// each setup/cleanup badge is day, team name, leader, task and the
// barcode" - title/description are repurposed here (team name/task text,
// swapped from their old task-text/section-title meaning) rather than
// adding yet more columns for two fields that already had a natural
// home; day/leader_name are genuinely new (see the migration that added
// them).
async function upsertTaskBadge(itemId, taskText, day, teamName, leaderName, barcode) {
  const existing = await db.prepare('SELECT id FROM misc_badges WHERE task_item_id = ?').get(itemId);
  if (existing) {
    await db
      .prepare('UPDATE misc_badges SET title = ?, description = ?, day = ?, leader_name = ? WHERE id = ?')
      .run(teamName, taskText, day, leaderName, existing.id);
    return;
  }
  await db
    .prepare(
      `INSERT INTO misc_badges (badge_type, badge_number, title, description, day, leader_name, barcode, task_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('setupCleanup', barcode, teamName, taskText, day, leaderName, barcode, itemId);
}

// Resolves the day/team name/leader a task list section's badges should
// print - the section's own linked setup_teams row when it has one
// (task_list_sections.team_id), falling back to the section's own
// day/title when it isn't linked to a team at all (a task list is
// allowed to exist unlinked - see createSection's own teamId being
// optional).
async function badgeContextForSection(section) {
  if (!section) return { day: null, teamName: null, leaderName: null };
  if (!section.team_id) return { day: section.day, teamName: section.title, leaderName: null };
  const team = await db
    .prepare(
      `SELECT st.title, st.day, m.name AS "leaderName" FROM setup_teams st
       LEFT JOIN members m ON m.id = st.leader_id AND m.active = 1
       WHERE st.id = ?`
    )
    .get(section.team_id);
  return team ? { day: team.day, teamName: team.title, leaderName: team.leaderName || null } : { day: section.day, teamName: section.title, leaderName: null };
}

// Re-stamps every badge under a team's linked task list with that team's
// CURRENT name/leader - without this, renaming a team or reassigning its
// leader would leave every already-printed-from item's badge silently
// showing the old value until that one item happened to be edited again.
// A no-op when the team has no linked task list section yet.
async function refreshBadgesForTeam(teamId) {
  const section = await db.prepare('SELECT * FROM task_list_sections WHERE team_id = ?').get(teamId);
  if (!section) return;
  const ctx = await badgeContextForSection(section);
  const items = await db.prepare('SELECT id, description, barcode FROM task_list_items WHERE section_id = ?').all(section.id);
  for (const item of items) await upsertTaskBadge(item.id, item.description, ctx.day, ctx.teamName, ctx.leaderName, item.barcode);
}

// Every task list section for a day, each with its own ordered task
// items (Number column = row position, not a hand-typed value - see
// reorderItems). teamTitle is set when a section is linked to a
// setup_teams row (see task_list_sections.team_id), so that team's own
// numbered tasks can print on its card too (item 31 - see
// tasksForTeam/routes' print handler).
async function taskListSectionsForDay(day) {
  const sections = await db
    .prepare(
      `SELECT ts.*, st.title AS "teamTitle"
       FROM task_list_sections ts
       LEFT JOIN setup_teams st ON st.id = ts.team_id
       WHERE ts.day = ?
       ORDER BY ts.position, ts.id`
    )
    .all(day);
  const result = [];
  for (const s of sections) result.push({ ...s, items: await itemsForSection(s.id) });
  return result;
}

async function itemsForSection(sectionId) {
  const items = await db.prepare('SELECT * FROM task_list_items WHERE section_id = ? ORDER BY position, id').all(sectionId);
  return items.map((item, i) => ({ ...item, number: i + 1 }));
}

async function getSection(id) {
  return db.prepare('SELECT * FROM task_list_sections WHERE id = ?').get(id);
}

async function nextSectionPosition(day) {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM task_list_sections WHERE day = ?').get(day);
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

async function createSection(day, title, teamId) {
  const info = await db
    .prepare('INSERT INTO task_list_sections (day, title, team_id, position) VALUES (?, ?, ?, ?)')
    .run(day, title, teamId || null, await nextSectionPosition(day));
  return info.lastInsertRowid;
}

async function updateSection(id, fields) {
  await db.prepare('UPDATE task_list_sections SET title = ?, team_id = ? WHERE id = ?').run(fields.title, fields.teamId || null, id);
  // A section's own title (unlinked) or its team link can both change
  // what a badge under it should print - re-stamp every item's badge
  // rather than leaving them showing whatever was true before this edit.
  const section = await getSection(id);
  const ctx = await badgeContextForSection(section);
  const items = await db.prepare('SELECT id, description, barcode FROM task_list_items WHERE section_id = ?').all(id);
  for (const item of items) await upsertTaskBadge(item.id, item.description, ctx.day, ctx.teamName, ctx.leaderName, item.barcode);
}

async function deleteSection(id) {
  await db.prepare('DELETE FROM task_list_sections WHERE id = ?').run(id);
}

// Drag-free reordering - swaps this section's position with its
// immediate up/down neighbor (a no-op at either end of the stack).
async function swapSectionPosition(day, sectionId, direction) {
  const sections = await db.prepare('SELECT id, position FROM task_list_sections WHERE day = ? ORDER BY position, id').all(day);
  const idx = sections.findIndex((s) => s.id === sectionId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sections.length) return;
  const a = sections[idx];
  const b = sections[swapIdx];
  await db.prepare('UPDATE task_list_sections SET position = ? WHERE id = ?').run(b.position, a.id);
  await db.prepare('UPDATE task_list_sections SET position = ? WHERE id = ?').run(a.position, b.id);
}

async function nextItemPosition(sectionId) {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM task_list_items WHERE section_id = ?').get(sectionId);
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

async function addItem(sectionId, description) {
  const barcode = await generateTaskCode();
  const info = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, ?, ?)')
    .run(sectionId, description, await nextItemPosition(sectionId), barcode);
  const itemId = info.lastInsertRowid;
  const ctx = await badgeContextForSection(await getSection(sectionId));
  await upsertTaskBadge(itemId, description, ctx.day, ctx.teamName, ctx.leaderName, barcode);
  return itemId;
}

async function updateItem(id, description) {
  await db.prepare('UPDATE task_list_items SET description = ? WHERE id = ?').run(description, id);
  const item = await db.prepare('SELECT * FROM task_list_items WHERE id = ?').get(id);
  if (!item) return;
  const ctx = await badgeContextForSection(await getSection(item.section_id));
  await upsertTaskBadge(id, description, ctx.day, ctx.teamName, ctx.leaderName, item.barcode);
}

async function deleteItem(id) {
  await db.prepare('DELETE FROM task_list_items WHERE id = ?').run(id);
}

async function swapItemPosition(sectionId, itemId, direction) {
  const items = await db.prepare('SELECT id, position FROM task_list_items WHERE section_id = ? ORDER BY position, id').all(sectionId);
  const idx = items.findIndex((it) => it.id === itemId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= items.length) return;
  const a = items[idx];
  const b = items[swapIdx];
  await db.prepare('UPDATE task_list_items SET position = ? WHERE id = ?').run(b.position, a.id);
  await db.prepare('UPDATE task_list_items SET position = ? WHERE id = ?').run(a.position, b.id);
}

// The one task list section (if any) linked to this team, numbered items
// included - used to print a team's own numbered task list on its card
// (item 31).
async function taskSectionForTeam(teamId) {
  const section = await db.prepare('SELECT * FROM task_list_sections WHERE team_id = ?').get(teamId);
  if (!section) return null;
  return { ...section, items: await itemsForSection(section.id) };
}

// Looks up a task by its own printed barcode - the parent checkout flow's
// second scan step (routes/checkout.js), confirming which Setup/Cleanup
// task they completed. Joins in the task's own section (title + day) so
// the checkout screen can show which list the task belongs to, the same
// way a member scan shows the member's own name.
async function findTaskItemByBarcode(barcode) {
  return db
    .prepare(
      `SELECT ti.*, ts.title AS "sectionTitle", ts.day AS "day"
       FROM task_list_items ti
       JOIN task_list_sections ts ON ts.id = ti.section_id
       WHERE ti.barcode = ?`
    )
    .get(barcode);
}

// A real request: "make an admin setup/cleanup card with a barcode. if
// someone doesn't have a setup cleanup card to scan the admin setup/
// cleanup card can be scanned to bypass the checkout demand for a setup/
// cleanup card... this card isn't linked to any specific member. its
// just a general bypass card." routes/checkout.js's task-scan step
// checks this AFTER findTaskItemByBarcode comes up empty - the seeded
// bypass badge (db/bootstrapPg.js's seedIfMissing) is the one 'setupCleanup'
// misc_badges row with no task_item_id, unlike every other row of that
// type, which is always auto-created 1:1 from a real task.
async function findSetupCleanupBypassBadge(barcode) {
  return db.prepare("SELECT * FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL AND barcode = ?").get(barcode);
}

module.exports = {
  taskListSectionsForDay,
  itemsForSection,
  getSection,
  createSection,
  updateSection,
  deleteSection,
  swapSectionPosition,
  addItem,
  updateItem,
  deleteItem,
  swapItemPosition,
  taskSectionForTeam,
  findTaskItemByBarcode,
  findSetupCleanupBypassBadge,
  refreshBadgesForTeam,
};

const db = require('../db');

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
  const info = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, ?)')
    .run(sectionId, description, await nextItemPosition(sectionId));
  return info.lastInsertRowid;
}

async function updateItem(id, description) {
  await db.prepare('UPDATE task_list_items SET description = ? WHERE id = ?').run(description, id);
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
};

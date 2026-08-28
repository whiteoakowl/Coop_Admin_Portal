// Resource Links - Main Admin-only (routes/main-admin-resource-links.js;
// a real request: "resource links should not be a tab on co-op admin
// portal" removed the Co-op Admin surface this used to also serve) and
// every member-facing portal that links to them (currently just Student
// Portal - see routes/student-portal.js).
const db = require('../db');

// Every APPROVED link visible to a given portal role, plus every
// unscoped (role_key IS NULL) link - oldest-first position, then id,
// matching the order they were added in the admin list. A member's own
// portal view never shows a still-pending submission (theirs or anyone
// else's) - only routes/main-admin-resource-links.js's Approvals tab
// does, via listPendingResourceLinks below.
async function listResourceLinksForRole(roleKey) {
  return db
    .prepare("SELECT * FROM resource_links WHERE status = 'approved' AND (role_key IS NULL OR role_key = ?) ORDER BY position ASC, id ASC")
    .all(roleKey);
}

// Every APPROVED link, grouped by category for the admin management
// screen's "list shows up categorized below" - a real request. Category-
// less links (category_id IS NULL) sort last under a null key the view
// renders as "Uncategorized".
async function listApprovedResourceLinksByCategory() {
  const rows = await db
    .prepare(
      `SELECT rl.*, rc.title AS "categoryTitle" FROM resource_links rl
       LEFT JOIN resource_link_categories rc ON rc.id = rl.category_id
       WHERE rl.status = 'approved'
       ORDER BY rc.position ASC NULLS LAST, LOWER(rc.title) ASC NULLS LAST, rl.position ASC, rl.id ASC`
    )
    .all();
  const groups = [];
  const byCategoryId = new Map();
  for (const row of rows) {
    const key = row.category_id || 'none';
    let group = byCategoryId.get(key);
    if (!group) {
      group = { categoryId: row.category_id, categoryTitle: row.categoryTitle || 'Uncategorized', links: [] };
      byCategoryId.set(key, group);
      groups.push(group);
    }
    group.links.push(row);
  }
  return groups;
}

// A real request: "members can submit resource links for approval...
// admin side should have tab under resource links for approvals."
async function listPendingResourceLinks() {
  return db
    .prepare(
      `SELECT rl.*, rc.title AS "categoryTitle", m.name AS "submittedByName" FROM resource_links rl
       LEFT JOIN resource_link_categories rc ON rc.id = rl.category_id
       LEFT JOIN members m ON m.id = rl.submitted_by_member_id
       WHERE rl.status = 'pending' ORDER BY rl.created_at ASC`
    )
    .all();
}

async function listCategories() {
  return db.prepare('SELECT * FROM resource_link_categories ORDER BY position, LOWER(title)').all();
}

async function nextCategoryPosition() {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM resource_link_categories').get();
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

// Same "duplicate add is a silent no-op, not an error" convention as
// utils/adminPositions.js's addAdminPosition.
async function addCategory(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;
  const info = await db
    .prepare('INSERT INTO resource_link_categories (title, position) VALUES (?, ?) ON CONFLICT (title) DO NOTHING')
    .run(trimmed, await nextCategoryPosition());
  return info.lastInsertRowid || null;
}

// ON DELETE SET NULL on resource_links.category_id (see this table's own
// migration) - deleting a category un-categorizes its links rather than
// deleting them.
async function deleteCategory(id) {
  await db.prepare('DELETE FROM resource_link_categories WHERE id = ?').run(id);
}

// A real request: "'Add Category' button should say 'add/edit category'"
// - each existing category gets its own rename field in that same popup,
// not just delete.
async function renameCategory(id, title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return;
  await db.prepare('UPDATE resource_link_categories SET title = ? WHERE id = ?').run(trimmed, id);
}

async function createResourceLink({ title, url, description, roleKey, city, state, categoryId, createdByAccountId }) {
  const info = await db
    .prepare(
      `INSERT INTO resource_links (title, url, description, role_key, city, state, category_id, status, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)`
    )
    .run(title, url, description || null, roleKey || null, city || null, state || null, categoryId || null, createdByAccountId || null);
  return info.lastInsertRowid;
}

// Member-facing submission - a real request: "members can submit
// resource links for approval." Always status 'pending', regardless of
// the admin-add path above which always lands 'approved' - an admin
// review (approveResourceLink/denyResourceLink below) is the only way a
// member submission ever reaches the public list.
async function submitResourceLink({ title, url, description, city, state, categoryId, submittedByMemberId }) {
  const info = await db
    .prepare(
      `INSERT INTO resource_links (title, url, description, city, state, category_id, status, submitted_by_member_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(title, url, description || null, city || null, state || null, categoryId || null, submittedByMemberId);
  return info.lastInsertRowid;
}

async function approveResourceLink(id) {
  await db.prepare("UPDATE resource_links SET status = 'approved' WHERE id = ?").run(id);
}

// Nothing useful to keep once a submission is rejected - see this
// table's own migration comment for why deny deletes outright instead of
// adding a third status.
async function denyResourceLink(id) {
  await db.prepare('DELETE FROM resource_links WHERE id = ?').run(id);
}

async function deleteResourceLink(id) {
  await db.prepare('DELETE FROM resource_links WHERE id = ?').run(id);
}

// A real request: "click on the resource, a window should pop up where
// you can edit the category and info and save."
async function updateResourceLink(id, { title, url, description, roleKey, city, state, categoryId }) {
  await db
    .prepare(
      `UPDATE resource_links SET title = ?, url = ?, description = ?, role_key = ?, city = ?, state = ?, category_id = ?
       WHERE id = ?`
    )
    .run(title, url, description || null, roleKey || null, city || null, state || null, categoryId || null, id);
}

module.exports = {
  listResourceLinksForRole,
  listApprovedResourceLinksByCategory,
  listPendingResourceLinks,
  listCategories,
  addCategory,
  deleteCategory,
  renameCategory,
  createResourceLink,
  submitResourceLink,
  approveResourceLink,
  denyResourceLink,
  deleteResourceLink,
  updateResourceLink,
};

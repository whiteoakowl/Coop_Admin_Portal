// Resource Links - shared helpers behind both admin surfaces
// (routes/admin-resource-links.js for Co-op Admin, routes/main-admin-
// resource-links.js for Main Admin) and every member-facing portal that
// links to them (currently just Student Portal - see routes/student-
// portal.js). One table, one set of helpers, same "two admin identity
// systems, one underlying feature" split routes/admin-announcements.js
// already established for Announcements.
const db = require('../db');

// Every link visible to a given portal role, plus every unscoped
// (role_key IS NULL) link - oldest-first position, then id, matching the
// order they were added in the admin list.
async function listResourceLinksForRole(roleKey) {
  return db
    .prepare('SELECT * FROM resource_links WHERE role_key IS NULL OR role_key = ? ORDER BY position ASC, id ASC')
    .all(roleKey);
}

// Every link, for the admin management screens - grouped by nothing in
// particular, just the same position/id order.
async function listAllResourceLinks() {
  return db.prepare('SELECT * FROM resource_links ORDER BY position ASC, id ASC').all();
}

async function createResourceLink({ title, url, description, roleKey, createdByAccountId }) {
  const info = await db
    .prepare('INSERT INTO resource_links (title, url, description, role_key, created_by_account_id) VALUES (?, ?, ?, ?, ?)')
    .run(title, url, description || null, roleKey || null, createdByAccountId || null);
  return info.lastInsertRowid;
}

async function deleteResourceLink(id) {
  await db.prepare('DELETE FROM resource_links WHERE id = ?').run(id);
}

module.exports = { listResourceLinksForRole, listAllResourceLinks, createResourceLink, deleteResourceLink };

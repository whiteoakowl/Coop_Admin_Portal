// Classifieds (Community & Commerce track, item 4) - same pending ->
// active -> archived moderation shape as utils/directory.js, plus a
// 'sold' status a member can mark themselves once an item is gone. See
// supabase/migrations/20260825040000_directory_classifieds.sql and
// 20260827090000_classified_categories.sql.
const db = require('../db');

const LISTING_SELECT = `SELECT l.*, c.title AS "categoryTitle" FROM classified_listings l LEFT JOIN classified_categories c ON c.id = l.category_id`;

async function listListings({ status, visibility } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('l.status = ?');
    params.push(status);
  }
  if (visibility) {
    clauses.push('l.visibility = ?');
    params.push(visibility);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`${LISTING_SELECT} ${where} ORDER BY l.created_at DESC`).all(...params);
}

// The Archive tab's own "everything not live and not awaiting review" -
// 'archived' (an admin or the member themselves put it away) and 'sold'
// (the member's own "this is gone" button, routes/classifieds.js's own
// POST /:id/sold) side by side, same reasoning listListings' single-
// status filter can't express in one call.
async function archivedListings() {
  return db.prepare(`${LISTING_SELECT} WHERE l.status IN ('archived', 'sold') ORDER BY l.updated_at DESC`).all();
}

// The Categories tab's own "list shows up categorized below" - a real
// request, same grouping shape as utils/resourceLinks.js's own
// listApprovedResourceLinksByCategory. Only 'active' (live) listings -
// pending ones belong on the Requests tab, archived/sold ones on Archive.
async function activeListingsByCategory() {
  const rows = await db
    .prepare(
      `${LISTING_SELECT}
       LEFT JOIN classified_categories cc ON cc.id = l.category_id
       WHERE l.status = 'active'
       ORDER BY cc.position ASC NULLS LAST, LOWER(cc.title) ASC NULLS LAST, l.created_at DESC`
    )
    .all();
  const groups = [];
  const byCategoryId = new Map();
  for (const row of rows) {
    const key = row.category_id || 'none';
    let group = byCategoryId.get(key);
    if (!group) {
      group = { categoryId: row.category_id, categoryTitle: row.categoryTitle || 'Uncategorized', listings: [] };
      byCategoryId.set(key, group);
      groups.push(group);
    }
    group.listings.push(row);
  }
  return groups;
}

async function listingsForMember(memberId) {
  return db.prepare(`${LISTING_SELECT} WHERE l.member_id = ? ORDER BY l.created_at DESC`).all(memberId);
}

async function getListing(id) {
  return db.prepare(`${LISTING_SELECT} WHERE l.id = ?`).get(id);
}

async function submitListing(data, memberId, accountId) {
  const info = await db
    .prepare(
      `INSERT INTO classified_listings (member_id, title, description, category_id, price, visibility, submitted_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, data.title, data.description || null, data.categoryId || null, data.price || null, data.visibility, accountId);
  return info.lastInsertRowid;
}

async function updateListing(id, data) {
  await db
    .prepare('UPDATE classified_listings SET title = ?, description = ?, category_id = ?, price = ?, visibility = ?, updated_at = now_text() WHERE id = ?')
    .run(data.title, data.description || null, data.categoryId || null, data.price || null, data.visibility, id);
}

async function setListingImage(id, imageKey) {
  await db.prepare('UPDATE classified_listings SET image_key = ?, updated_at = now_text() WHERE id = ?').run(imageKey, id);
}

async function setListingStatus(id, status, accountId) {
  if (status === 'active') {
    await db.prepare('UPDATE classified_listings SET status = ?, approved_by_account_id = ?, approved_at = now_text(), updated_at = now_text() WHERE id = ?').run(status, accountId, id);
  } else {
    await db.prepare('UPDATE classified_listings SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
  }
}

async function deleteListing(id) {
  await db.prepare('DELETE FROM classified_listings WHERE id = ?').run(id);
}

// --- Categories: admin-only, same add/delete-only shape as
// utils/resourceLinks.js's own listCategories/addCategory/deleteCategory
// - see that file's own comments for the reasoning this mirrors. ---

async function listCategories() {
  return db.prepare('SELECT * FROM classified_categories ORDER BY position, LOWER(title)').all();
}

async function nextCategoryPosition() {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM classified_categories').get();
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

async function addCategory(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;
  const info = await db
    .prepare('INSERT INTO classified_categories (title, position) VALUES (?, ?) ON CONFLICT (title) DO NOTHING')
    .run(trimmed, await nextCategoryPosition());
  return info.lastInsertRowid || null;
}

// ON DELETE SET NULL on classified_listings.category_id (see this
// table's own migration) - deleting a category un-categorizes its
// listings rather than deleting them.
async function deleteCategory(id) {
  await db.prepare('DELETE FROM classified_categories WHERE id = ?').run(id);
}

module.exports = {
  listListings,
  archivedListings,
  activeListingsByCategory,
  listingsForMember,
  getListing,
  submitListing,
  updateListing,
  setListingImage,
  setListingStatus,
  deleteListing,
  listCategories,
  addCategory,
  deleteCategory,
};

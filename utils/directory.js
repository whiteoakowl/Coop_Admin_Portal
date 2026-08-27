// Business Directory (Community & Commerce track, item 4). A member
// submits a listing about their own business ('pending'); a Main Admin
// ('manage_directory') approves it to 'active' or archives it. Same
// public/members visibility toggle and pending -> active -> archived
// status shape classified_listings uses right alongside it - see
// supabase/migrations/20260825040000_directory_classifieds.sql and
// 20260827100000_directory_categories.sql.
const db = require('../db');

const LISTING_SELECT = `SELECT l.*, c.title AS "categoryTitle" FROM business_directory_listings l LEFT JOIN business_directory_categories c ON c.id = l.category_id`;

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
  return db.prepare(`${LISTING_SELECT} ${where} ORDER BY l.business_name`).all(...params);
}

// The Archive tab's own listing set.
async function archivedListings() {
  return db.prepare(`${LISTING_SELECT} WHERE l.status = 'archived' ORDER BY l.updated_at DESC`).all();
}

// The Directory tab's own "list shows up categorized below" - a real
// request, same grouping shape as utils/resourceLinks.js's own
// listApprovedResourceLinksByCategory and utils/classifieds.js's own
// activeListingsByCategory. Only 'active' (live) listings - pending ones
// belong on the Requests tab, archived ones on Archive.
async function activeListingsByCategory() {
  const rows = await db
    .prepare(
      `${LISTING_SELECT}
       LEFT JOIN business_directory_categories bc ON bc.id = l.category_id
       WHERE l.status = 'active'
       ORDER BY bc.position ASC NULLS LAST, LOWER(bc.title) ASC NULLS LAST, LOWER(l.business_name) ASC`
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
      `INSERT INTO business_directory_listings
       (member_id, business_name, description, category_id, phone, email, website, address, visibility, submitted_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, data.businessName, data.description || null, data.categoryId || null, data.phone || null, data.email || null, data.website || null, data.address || null, data.visibility, accountId);
  return info.lastInsertRowid;
}

async function updateListing(id, data) {
  await db
    .prepare(
      `UPDATE business_directory_listings SET business_name = ?, description = ?, category_id = ?, phone = ?, email = ?, website = ?, address = ?, visibility = ?, updated_at = now_text()
       WHERE id = ?`
    )
    .run(data.businessName, data.description || null, data.categoryId || null, data.phone || null, data.email || null, data.website || null, data.address || null, data.visibility, id);
}

async function setListingImage(id, imageKey) {
  await db.prepare('UPDATE business_directory_listings SET image_key = ?, updated_at = now_text() WHERE id = ?').run(imageKey, id);
}

async function setListingStatus(id, status, accountId) {
  if (status === 'active') {
    await db.prepare('UPDATE business_directory_listings SET status = ?, approved_by_account_id = ?, approved_at = now_text(), updated_at = now_text() WHERE id = ?').run(status, accountId, id);
  } else {
    await db.prepare('UPDATE business_directory_listings SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
  }
}

async function deleteListing(id) {
  await db.prepare('DELETE FROM business_directory_listings WHERE id = ?').run(id);
}

// --- Categories: admin-only, same add/delete-only shape as
// utils/resourceLinks.js and utils/classifieds.js's own category
// helpers - see either's comments for the reasoning this mirrors. ---

async function listCategories() {
  return db.prepare('SELECT * FROM business_directory_categories ORDER BY position, LOWER(title)').all();
}

async function nextCategoryPosition() {
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM business_directory_categories').get();
  return (row && row.maxPos != null ? row.maxPos : -1) + 1;
}

async function addCategory(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;
  const info = await db
    .prepare('INSERT INTO business_directory_categories (title, position) VALUES (?, ?) ON CONFLICT (title) DO NOTHING')
    .run(trimmed, await nextCategoryPosition());
  return info.lastInsertRowid || null;
}

// ON DELETE SET NULL on business_directory_listings.category_id (see
// this table's own migration) - deleting a category un-categorizes its
// listings rather than deleting them.
async function deleteCategory(id) {
  await db.prepare('DELETE FROM business_directory_categories WHERE id = ?').run(id);
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

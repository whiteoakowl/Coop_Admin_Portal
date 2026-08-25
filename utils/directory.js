// Business Directory (Community & Commerce track, item 4). A member
// submits a listing about their own business ('pending'); a Main Admin
// ('manage_directory') approves it to 'active' or archives it. Same
// public/members visibility toggle and pending -> active -> archived
// status shape classified_listings uses right alongside it - see
// supabase/migrations/20260825040000_directory_classifieds.sql.
const db = require('../db');

async function listListings({ status, visibility } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (visibility) {
    clauses.push('visibility = ?');
    params.push(visibility);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM business_directory_listings ${where} ORDER BY business_name`).all(...params);
}

async function listingsForMember(memberId) {
  return db.prepare('SELECT * FROM business_directory_listings WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
}

async function getListing(id) {
  return db.prepare('SELECT * FROM business_directory_listings WHERE id = ?').get(id);
}

async function submitListing(data, memberId, accountId) {
  const info = await db
    .prepare(
      `INSERT INTO business_directory_listings
       (member_id, business_name, description, category, phone, email, website, address, visibility, submitted_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, data.businessName, data.description || null, data.category || null, data.phone || null, data.email || null, data.website || null, data.address || null, data.visibility, accountId);
  return info.lastInsertRowid;
}

async function updateListing(id, data) {
  await db
    .prepare(
      `UPDATE business_directory_listings SET business_name = ?, description = ?, category = ?, phone = ?, email = ?, website = ?, address = ?, visibility = ?, updated_at = now_text()
       WHERE id = ?`
    )
    .run(data.businessName, data.description || null, data.category || null, data.phone || null, data.email || null, data.website || null, data.address || null, data.visibility, id);
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

module.exports = {
  listListings,
  listingsForMember,
  getListing,
  submitListing,
  updateListing,
  setListingImage,
  setListingStatus,
  deleteListing,
};

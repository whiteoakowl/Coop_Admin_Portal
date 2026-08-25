// Classifieds (Community & Commerce track, item 4) - same pending ->
// active -> archived moderation shape as utils/directory.js, plus a
// 'sold' status a member can mark themselves once an item is gone. See
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
  return db.prepare(`SELECT * FROM classified_listings ${where} ORDER BY created_at DESC`).all(...params);
}

async function listingsForMember(memberId) {
  return db.prepare('SELECT * FROM classified_listings WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
}

async function getListing(id) {
  return db.prepare('SELECT * FROM classified_listings WHERE id = ?').get(id);
}

async function submitListing(data, memberId, accountId) {
  const info = await db
    .prepare(
      `INSERT INTO classified_listings (member_id, title, description, category, price, visibility, submitted_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(memberId, data.title, data.description || null, data.category || null, data.price || null, data.visibility, accountId);
  return info.lastInsertRowid;
}

async function updateListing(id, data) {
  await db
    .prepare('UPDATE classified_listings SET title = ?, description = ?, category = ?, price = ?, visibility = ?, updated_at = now_text() WHERE id = ?')
    .run(data.title, data.description || null, data.category || null, data.price || null, data.visibility, id);
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

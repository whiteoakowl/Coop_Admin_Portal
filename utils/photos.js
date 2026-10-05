// Photos/Albums (Community & Commerce track, item 12). See the
// migration's own header comment on why visibility defaults to
// 'members' and 'public' is a deliberate, separate admin choice - the
// same reasoning applies to every function here that touches
// visibility.
const db = require('../db');

async function listAlbums({ visibility, status = 'active' } = {}) {
  return visibility
    ? db.prepare('SELECT * FROM photo_albums WHERE visibility = ? AND status = ? ORDER BY created_at DESC').all(visibility, status)
    : db.prepare('SELECT * FROM photo_albums WHERE status = ? ORDER BY created_at DESC').all(status);
}

async function getAlbum(id) {
  return db.prepare('SELECT * FROM photo_albums WHERE id = ?').get(id);
}

async function createAlbum({ title, description, visibility, allowMemberUploads }, accountId) {
  const info = await db
    .prepare("INSERT INTO photo_albums (title, description, visibility, allow_member_uploads, created_by_account_id) VALUES (?, ?, ?, ?, ?)")
    .run(title, description, visibility === 'public' ? 'public' : 'members', allowMemberUploads ? 1 : 0, accountId);
  return info.lastInsertRowid;
}

async function updateAlbum(id, { title, description, visibility, allowMemberUploads }) {
  await db
    .prepare('UPDATE photo_albums SET title = ?, description = ?, visibility = ?, allow_member_uploads = ?, updated_at = now_text() WHERE id = ?')
    .run(title, description, visibility === 'public' ? 'public' : 'members', allowMemberUploads ? 1 : 0, id);
}

async function deleteAlbum(id) {
  await db.prepare('DELETE FROM photo_albums WHERE id = ?').run(id);
}

// "Add archive subpage under photos tab" - same active/archived shape
// Business Directory/Classifieds/Shop already use.
async function archiveAlbum(id) {
  await db.prepare("UPDATE photo_albums SET status = 'archived', updated_at = now_text() WHERE id = ?").run(id);
}

async function unarchiveAlbum(id) {
  await db.prepare("UPDATE photo_albums SET status = 'active', updated_at = now_text() WHERE id = ?").run(id);
}

async function listPhotos(albumId, { status } = {}) {
  return status
    ? db.prepare('SELECT * FROM photo_album_photos WHERE album_id = ? AND status = ? ORDER BY created_at').all(albumId, status)
    : db.prepare('SELECT * FROM photo_album_photos WHERE album_id = ? ORDER BY created_at').all(albumId);
}

async function getPhoto(id) {
  return db.prepare('SELECT * FROM photo_album_photos WHERE id = ?').get(id);
}

async function addPhoto(albumId, imageKey, caption, accountId, status = 'approved') {
  const info = await db
    .prepare('INSERT INTO photo_album_photos (album_id, image_key, caption, uploaded_by_account_id, status) VALUES (?, ?, ?, ?, ?)')
    .run(albumId, imageKey, caption, accountId, status);
  return info.lastInsertRowid;
}

async function removePhoto(id) {
  await db.prepare('DELETE FROM photo_album_photos WHERE id = ?').run(id);
}

// Item 6 - Main Admin homepage pending-requests counter/list.
async function listPendingPhotos() {
  return db
    .prepare(
      `SELECT p.*, a.title AS "albumTitle" FROM photo_album_photos p
       JOIN photo_albums a ON a.id = p.album_id
       WHERE p.status = 'pending' ORDER BY p.created_at`
    )
    .all();
}

async function decidePhotoSubmission(id, approve) {
  await db.prepare('UPDATE photo_album_photos SET status = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', id);
}

async function setCoverImage(albumId, imageKey) {
  await db.prepare('UPDATE photo_albums SET cover_image_key = ?, updated_at = now_text() WHERE id = ?').run(imageKey, albumId);
}

module.exports = {
  listAlbums,
  getAlbum,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  archiveAlbum,
  unarchiveAlbum,
  listPhotos,
  getPhoto,
  addPhoto,
  removePhoto,
  setCoverImage,
  listPendingPhotos,
  decidePhotoSubmission,
};

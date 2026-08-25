// Photos/Albums (Community & Commerce track, item 12). See the
// migration's own header comment on why visibility defaults to
// 'members' and 'public' is a deliberate, separate admin choice - the
// same reasoning applies to every function here that touches
// visibility.
const db = require('../db');

async function listAlbums({ visibility } = {}) {
  return visibility
    ? db.prepare('SELECT * FROM photo_albums WHERE visibility = ? ORDER BY created_at DESC').all(visibility)
    : db.prepare('SELECT * FROM photo_albums ORDER BY created_at DESC').all();
}

async function getAlbum(id) {
  return db.prepare('SELECT * FROM photo_albums WHERE id = ?').get(id);
}

async function createAlbum({ title, description, visibility }, accountId) {
  const info = await db
    .prepare("INSERT INTO photo_albums (title, description, visibility, created_by_account_id) VALUES (?, ?, ?, ?)")
    .run(title, description, visibility === 'public' ? 'public' : 'members', accountId);
  return info.lastInsertRowid;
}

async function updateAlbum(id, { title, description, visibility }) {
  await db
    .prepare('UPDATE photo_albums SET title = ?, description = ?, visibility = ?, updated_at = now_text() WHERE id = ?')
    .run(title, description, visibility === 'public' ? 'public' : 'members', id);
}

async function deleteAlbum(id) {
  await db.prepare('DELETE FROM photo_albums WHERE id = ?').run(id);
}

async function listPhotos(albumId) {
  return db.prepare('SELECT * FROM photo_album_photos WHERE album_id = ? ORDER BY created_at').all(albumId);
}

async function getPhoto(id) {
  return db.prepare('SELECT * FROM photo_album_photos WHERE id = ?').get(id);
}

async function addPhoto(albumId, imageKey, caption, accountId) {
  const info = await db
    .prepare('INSERT INTO photo_album_photos (album_id, image_key, caption, uploaded_by_account_id) VALUES (?, ?, ?, ?)')
    .run(albumId, imageKey, caption, accountId);
  return info.lastInsertRowid;
}

async function removePhoto(id) {
  await db.prepare('DELETE FROM photo_album_photos WHERE id = ?').run(id);
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
  listPhotos,
  getPhoto,
  addPhoto,
  removePhoto,
  setCoverImage,
};

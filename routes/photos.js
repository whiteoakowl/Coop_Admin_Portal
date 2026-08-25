// Member/public-facing Photos/Albums (Community & Commerce track, item
// 12), mounted at /photos (server.js). A 'public' album is browsable
// signed-out, same public/member split Events already established; a
// 'members' album (the default - see the migration's own header
// comment) requires sign-in, checked on every route that touches an
// album, not just the listing page. Every photo file is proxied through
// this router's own /photos/:albumId/image/:photoId route rather than a
// public bucket URL - see routes/admin-photos.js's own comment on why.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { createStorageClient, downloadFile } = require('../utils/storage');
const photos = require('../utils/photos');

const PHOTOS_BUCKET = 'private-photos';
const PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'photos');
const storageClient = createStorageClient();

async function canView(req, album) {
  if (!album) return false;
  if (album.visibility === 'public') return true;
  return !!req.portalAccount;
}

async function sendImage(res, imageKey) {
  if (!imageKey) return res.status(404).render('404', { title: 'Not Found' });
  if (storageClient) {
    const buffer = await downloadFile(storageClient, PHOTOS_BUCKET, imageKey);
    res.setHeader('Content-Type', 'image/*');
    return res.send(buffer);
  }
  const filePath = path.join(PHOTOS_DIR, path.basename(imageKey));
  if (!fs.existsSync(filePath)) return res.status(404).render('404', { title: 'Not Found' });
  res.sendFile(filePath);
}

router.get('/', async (req, res) => {
  const albums = await photos.listAlbums(req.portalAccount ? {} : { visibility: 'public' });
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('photos-list', { title: 'Photos', settings, albums });
});

router.get('/:id', async (req, res) => {
  const album = await photos.getAlbum(req.params.id);
  if (!(await canView(req, album))) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const albumPhotos = await photos.listPhotos(album.id);
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('photos-detail', { title: album.title, settings, album, photos: albumPhotos });
});

// A dedicated cover-photo route (rather than making the caller know a
// specific photo id) - the listing page renders one thumbnail per album
// without first fetching its photos.
router.get('/:id/cover', async (req, res) => {
  const album = await photos.getAlbum(req.params.id);
  if (!(await canView(req, album))) return res.status(404).render('404', { title: 'Not Found' });
  await sendImage(res, album.cover_image_key);
});

router.get('/:albumId/image/:photoId', async (req, res) => {
  const album = await photos.getAlbum(req.params.albumId);
  if (!(await canView(req, album))) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const photo = await photos.getPhoto(req.params.photoId);
  if (!photo || photo.album_id !== album.id) return res.status(404).render('404', { title: 'Not Found' });
  await sendImage(res, photo.image_key);
});

module.exports = router;

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
const multer = require('multer');
const archiver = require('archiver');
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { createStorageClient, downloadFile, uploadFile, generateKey } = require('../utils/storage');
const { imageFileFilter } = require('../utils/uploads');
const photos = require('../utils/photos');

const PHOTOS_BUCKET = 'private-photos';
const PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'photos');
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// Members upload to an existing album - a real request: "admins can
// create albums that members can upload to. members can't upload
// albums." There's no member-facing create-album route in this file at
// all (only routes/admin-photos.js has one), so that half is already
// true by construction; this is the other half.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

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
  res.render('photos-detail', { title: album.title, settings, album, photos: albumPhotos, error: req.query.error || null, notice: req.query.notice || null });
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

// A real request: "admins can create albums that members can upload to.
// members can't upload albums." canView's own visibility check (public
// or signed-in) still applies - a member has to be able to SEE an album
// before they can add to it, same rule the album's own detail page
// already enforces.
router.post('/:id/upload', requirePortalAuth, upload.array('images', 20), async (req, res) => {
  const album = await photos.getAlbum(req.params.id);
  if (!(await canView(req, album))) return res.status(404).render('404', { title: 'Not Found' });
  if (!req.files || !req.files.length) return res.redirect(`/photos/${album.id}?error=` + encodeURIComponent('Please choose at least one image.'));

  let firstKey = null;
  for (const file of req.files) {
    let key;
    if (storageClient) {
      key = await uploadFile(storageClient, PHOTOS_BUCKET, file.buffer, file.originalname, file.mimetype);
    } else {
      key = generateKey(file.originalname);
      fs.writeFileSync(path.join(PHOTOS_DIR, key), file.buffer);
    }
    await photos.addPhoto(album.id, key, (req.body.caption || '').trim(), req.portalAccount.id);
    if (!firstKey) firstKey = key;
  }
  if (!album.cover_image_key && firstKey) await photos.setCoverImage(album.id, firstKey);
  res.redirect(`/photos/${album.id}?notice=` + encodeURIComponent('Photo(s) added.'));
});

// A real request: "there should be a download button for each album so
// admins and members can download an entire album." Streams a zip
// straight to the response rather than building one on disk first - an
// album's photos can add up, and this never has to hold more than one
// photo's bytes in memory at a time.
router.get('/:id/download', async (req, res) => {
  const album = await photos.getAlbum(req.params.id);
  if (!(await canView(req, album))) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const albumPhotos = await photos.listPhotos(album.id);
  if (albumPhotos.length === 0) return res.status(404).render('404', { title: 'Not Found' });

  const safeTitle = (album.title || 'album').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.attachment(`${safeTitle}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end(String(err)));
  archive.pipe(res);

  let index = 0;
  for (const photo of albumPhotos) {
    index += 1;
    const ext = path.extname(photo.image_key) || '.jpg';
    const base = (photo.caption || `photo-${index}`).replace(/[^a-z0-9-_ ]+/gi, '').trim() || `photo-${index}`;
    const entryName = `${String(index).padStart(3, '0')}-${base}${ext}`;
    if (storageClient) {
      const buffer = await downloadFile(storageClient, PHOTOS_BUCKET, photo.image_key);
      archive.append(buffer, { name: entryName });
    } else {
      const filePath = path.join(PHOTOS_DIR, path.basename(photo.image_key));
      if (fs.existsSync(filePath)) archive.append(fs.createReadStream(filePath), { name: entryName });
    }
  }
  await archive.finalize();
});

module.exports = router;

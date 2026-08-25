// Main Admin's Photos/Albums management (Community & Commerce track,
// item 12) - mounted at /main-admin/photos, gated by manage_publications
// (already covers "photo albums" per its own seeded description in
// db/bootstrapPg.js). Photo files are stored in a PRIVATE bucket/local-
// disk-outside-public/, same pattern as routes/custom-forms.js's own
// file answers, and proxied exclusively through the authenticated
// /photos/:albumId/image/:photoId route in routes/photos.js - never a
// public bucket URL, even for a 'members' album's own thumbnails,
// because express.static would serve those unconditionally regardless
// of the album's visibility. See the migration's own header comment for
// why 'public' is a deliberate, separate choice, never the default.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, generateKey } = require('../utils/storage');
const photos = require('../utils/photos');
const auditLog = require('../utils/auditLog');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_publications'));

const PHOTOS_BUCKET = 'private-photos';
const PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'photos');
const storageClient = createStorageClient();
if (!storageClient && !fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

router.get('/', async (req, res) => {
  const albums = await photos.listAlbums();
  res.render('admin-photos-list', { title: 'Photos', albums, notice: req.query.notice || null });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/photos?notice=' + encodeURIComponent('A title is required.'));
  const id = await photos.createAlbum({ title, description: (req.body.description || '').trim(), visibility: req.body.visibility }, req.portalAccount.id);
  res.redirect(`/main-admin/photos/${id}/edit`);
});

async function loadEditor(req, res) {
  const album = await photos.getAlbum(req.params.id);
  if (!album) return res.status(404).render('404', { title: 'Not Found' });
  const albumPhotos = await photos.listPhotos(album.id);
  res.render('admin-photos-edit', { title: album.title, album, photos: albumPhotos, error: req.query.error || null, notice: req.query.notice || null });
}
router.get('/:id/edit', loadEditor);

router.post('/:id', async (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect(`/main-admin/photos/${id}/edit?error=` + encodeURIComponent('A title is required.'));
  await photos.updateAlbum(id, { title, description: (req.body.description || '').trim(), visibility: req.body.visibility });
  res.redirect(`/main-admin/photos/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

router.post('/:id/delete', async (req, res) => {
  const album = await photos.getAlbum(req.params.id);
  if (album) {
    const albumPhotos = await photos.listPhotos(album.id);
    for (const photo of albumPhotos) {
      if (storageClient) await deleteFile(storageClient, PHOTOS_BUCKET, photo.image_key);
      else {
        const p = path.join(PHOTOS_DIR, photo.image_key);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  }
  await photos.deleteAlbum(req.params.id);
  await auditLog.record(req.portalAccount.id, 'photo_album_deleted', 'photo_album', req.params.id, album?.title);
  res.redirect('/main-admin/photos?notice=' + encodeURIComponent('Album deleted.'));
});

router.post('/:id/photos', upload.array('images', 20), async (req, res) => {
  const albumId = req.params.id;
  if (!req.files || !req.files.length) return res.redirect(`/main-admin/photos/${albumId}/edit?error=` + encodeURIComponent('Please choose at least one image.'));
  let firstKey = null;
  for (const file of req.files) {
    let key;
    if (storageClient) {
      key = await uploadFile(storageClient, PHOTOS_BUCKET, file.buffer, file.originalname, file.mimetype);
    } else {
      key = generateKey(file.originalname);
      fs.writeFileSync(path.join(PHOTOS_DIR, key), file.buffer);
    }
    await photos.addPhoto(albumId, key, (req.body.caption || '').trim(), req.portalAccount.id);
    if (!firstKey) firstKey = key;
  }
  const album = await photos.getAlbum(albumId);
  if (!album.cover_image_key && firstKey) await photos.setCoverImage(albumId, firstKey);
  res.redirect(`/main-admin/photos/${albumId}/edit?notice=` + encodeURIComponent('Photo(s) added.'));
});

router.post('/:id/photos/:photoId/cover', async (req, res) => {
  const photo = await photos.getPhoto(req.params.photoId);
  if (photo) await photos.setCoverImage(req.params.id, photo.image_key);
  res.redirect(`/main-admin/photos/${req.params.id}/edit?notice=` + encodeURIComponent('Cover photo set.'));
});

router.post('/:id/photos/:photoId/delete', async (req, res) => {
  const photo = await photos.getPhoto(req.params.photoId);
  if (photo) {
    if (storageClient) await deleteFile(storageClient, PHOTOS_BUCKET, photo.image_key);
    else {
      const p = path.join(PHOTOS_DIR, photo.image_key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await photos.removePhoto(photo.id);
  }
  res.redirect(`/main-admin/photos/${req.params.id}/edit?notice=` + encodeURIComponent('Photo removed.'));
});

module.exports = router;

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
if (!storageClient && !fs.existsSync(PHOTOS_DIR)) {
  try {
    fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${PHOTOS_DIR}:`, err.message);
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });

const PHOTOS_TABS = ['photos', 'archive'];

router.get('/', async (req, res) => {
  const activeTab = PHOTOS_TABS.includes(req.query.tab) ? req.query.tab : 'photos';
  const albums = await photos.listAlbums({ status: activeTab === 'archive' ? 'archived' : 'active' });
  const pendingPhotos = activeTab === 'photos' ? await photos.listPendingPhotos() : [];
  res.render('admin-photos-list', { title: 'Photos', activeTab, albums, pendingPhotos, notice: req.query.notice || null });
});

router.post('/', async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.redirect('/main-admin/photos?notice=' + encodeURIComponent('A title is required.'));
  const id = await photos.createAlbum(
    { title, description: (req.body.description || '').trim(), visibility: req.body.visibility, allowMemberUploads: req.body.allowMemberUploads === '1' },
    req.portalAccount.id
  );
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
  await photos.updateAlbum(id, {
    title,
    description: (req.body.description || '').trim(),
    visibility: req.body.visibility,
    allowMemberUploads: req.body.allowMemberUploads === '1',
  });
  res.redirect(`/main-admin/photos/${id}/edit?notice=` + encodeURIComponent('Saved.'));
});

// "Archive button added next to it in the same row. Add archive
// subpage under photos tab."
router.post('/:id/archive', async (req, res) => {
  await photos.archiveAlbum(req.params.id);
  res.redirect('/main-admin/photos?notice=' + encodeURIComponent('Album archived.'));
});

router.post('/:id/unarchive', async (req, res) => {
  await photos.unarchiveAlbum(req.params.id);
  res.redirect('/main-admin/photos?tab=archive&notice=' + encodeURIComponent('Album restored.'));
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

// A real request: "allow to upload a cover photo when editing" - a
// direct upload instead of the roundabout "add it to the gallery, then
// Set as Cover" flow above. Doesn't delete the album's previous
// cover_image_key file - that key may still be shared with a live
// gallery photo (set via the button above), so deleting it here could
// destroy a photo that's still in the gallery.
router.post('/:id/cover', upload.single('coverImage'), async (req, res) => {
  const albumId = req.params.id;
  if (!req.file) return res.redirect(`/main-admin/photos/${albumId}/edit?error=` + encodeURIComponent('Please choose an image file.'));
  let key;
  if (storageClient) {
    key = await uploadFile(storageClient, PHOTOS_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
  } else {
    key = generateKey(req.file.originalname);
    fs.writeFileSync(path.join(PHOTOS_DIR, key), req.file.buffer);
  }
  await photos.setCoverImage(albumId, key);
  res.redirect(`/main-admin/photos/${albumId}/edit?notice=` + encodeURIComponent('Cover photo updated.'));
});

router.post('/:id/photos/:photoId/decide', async (req, res) => {
  await photos.decidePhotoSubmission(req.params.photoId, req.body.decision === 'approve');
  res.redirect(`/main-admin/photos/${req.params.id}/edit?notice=` + encodeURIComponent(req.body.decision === 'approve' ? 'Photo approved.' : 'Photo rejected.'));
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

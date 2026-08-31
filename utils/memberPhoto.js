// Member profile photo storage - shared by both portals' own member
// Add/Edit forms (routes/admin-members.js, routes/main-admin-members.js)
// so a real request ("Membership forms on the co-op admin page should be
// the same as the main admin member profiles") can't drift into two
// separate upload implementations for the exact same field. Goes to
// Supabase Storage when configured, local disk otherwise (see
// utils/uploadBackend.js and MIGRATION.md) - multer uses memoryStorage
// regardless of backend, since a Storage upload needs the raw buffer
// anyway and the local-disk path writes that same buffer itself (via
// saveUpload) rather than letting multer write it.
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { imageFileFilter } = require('./uploads');
const { createStorageClient } = require('./storage');
const { saveUpload, removeUpload } = require('./uploadBackend');

const MEMBER_PHOTOS_BUCKET = 'member-photos';
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'members');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const storageClient = createStorageClient();
// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured.
if (!storageClient && !fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: imageFileFilter,
});

// A photo over the limit above makes multer.single() itself throw a
// MulterError (LIMIT_FILE_SIZE), which - unlike imageFileFilter rejecting
// a wrong file TYPE (that just leaves req.file undefined) - was never
// caught anywhere, so it fell through to server.js's generic catch-all
// error handler: a bare 500 page that threw away every other field the
// admin had just typed (name, address, medical notes, family). Same fix
// as routes/admin-documents.js's own uploadDocument wrapper, parametrized
// by redirect target since each caller's own edit page redirects back to
// itself on error.
function uploadMemberPhoto(redirectTo) {
  return function (req, res, next) {
    uploadPhoto.single('photo')(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.redirect(`${redirectTo(req)}?error=` + encodeURIComponent(`That photo is too large - photos are limited to ${MAX_PHOTO_BYTES / (1024 * 1024)}MB.`));
      }
      next(err);
    });
  };
}

// Saves an uploaded photo (Storage or local disk, see above) and returns
// the key to store in photo_path.
function savePhotoFile(file) {
  return saveUpload({
    client: storageClient,
    bucket: MEMBER_PHOTOS_BUCKET,
    localDir: PHOTO_DIR,
    buffer: file.buffer,
    originalName: file.originalname,
    contentType: file.mimetype,
  });
}

// Removes a member's stored photo given the key/path in photo_path -
// called whenever a photo is replaced or the member itself is deleted, so
// an old photo of a real child or parent doesn't sit around forever with
// no way to remove it once it's no longer referenced anywhere. Silently
// no-ops for null/already-missing files (deleting a member who never had
// a photo is the common case, not an error).
function deletePhotoFile(photoPath) {
  return removeUpload({ client: storageClient, bucket: MEMBER_PHOTOS_BUCKET, localDir: PHOTO_DIR, key: photoPath });
}

module.exports = { uploadMemberPhoto, savePhotoFile, deletePhotoFile };

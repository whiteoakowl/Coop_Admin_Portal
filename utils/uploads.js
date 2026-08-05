// Shared multer fileFilter for image uploads (member photos, name tag /
// schedule card design images). Checking mimetype alone trusts a header
// the client fully controls; an admin could claim image/svg+xml for a
// file containing an inline <script> and have it served back same-origin.
// Requiring both the declared mimetype AND a matching real extension
// closes that off without needing to decode/re-encode the upload.
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function imageFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const okType = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
  cb(null, okType && IMAGE_EXTENSIONS.has(ext));
}

module.exports = { imageFileFilter };

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

// Documents tab uploads: PDF and the common Word formats, same
// mimetype-plus-extension check as images above.
const DOCUMENT_MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function documentFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const expectedType = DOCUMENT_MIME_BY_EXT[ext];
  cb(null, Boolean(expectedType) && file.mimetype === expectedType);
}

module.exports = { imageFileFilter, documentFileFilter, DOCUMENT_MIME_BY_EXT };

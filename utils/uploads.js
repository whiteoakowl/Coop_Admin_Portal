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

// Spreadsheet-import uploads (Members, Class Schedule, Task List,
// Floater Teams, roster/schedule imports - every "Import" button in the
// app that reads a .csv/.txt/.xlsx via utils/spreadsheet.js's
// readRowsFromFile). These never touch disk (memoryStorage, parsed and
// discarded) or get served back out, so extension-only filtering is
// enough here - the mimetype-plus-extension pairing used above for
// images/documents exists specifically to stop a served-back file being
// mistaken for something it isn't, which doesn't apply to a file that's
// never written or served. Browsers are also inconsistent about what
// mimetype they even send for .csv/.txt across OS/browser combinations,
// so requiring a mimetype match here would reject real, legitimate files.
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.txt', '.xlsx']);

function spreadsheetFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  cb(null, SPREADSHEET_EXTENSIONS.has(ext));
}

// Database restore upload (Admin > Settings > Restore). Extension-only,
// same reasoning as spreadsheets above - it's read into a temp file and
// validated as a real SQLite database by utils/backup.js before anything
// is trusted, so the actual gatekeeping happens there, not here.
function databaseFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  cb(null, ext === '.db');
}

module.exports = {
  imageFileFilter,
  documentFileFilter,
  DOCUMENT_MIME_BY_EXT,
  spreadsheetFileFilter,
  databaseFileFilter,
};

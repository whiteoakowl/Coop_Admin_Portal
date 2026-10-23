// Proxy-download for the private family-school-attachments Supabase
// Storage bucket (logos, lesson attachments, journal attachments,
// weekly planner files) - a real decision that bucket should be
// private, not public, so there is no stable public URL to hand back
// at all (see utils/familySchool.js's own attachmentUrl() comment).
// Mounted at the bare root (server.js: app.use('/', familySchoolFiles
// Router)) rather than under /parent or /student specifically, because
// the SAME key can legitimately need to be fetched by either portal -
// a parent viewing their own lesson content, or a student viewing that
// same shared lesson. Gated only by requirePortalAuth (any signed-in
// portal account, any role); the real authorization is
// attachmentAccessForFamily() below confirming THIS account's own
// family actually owns the key before anything is streamed back - a
// wrong guess at someone else's key 404s exactly like a key that
// doesn't exist at all, never confirming which.
const express = require('express');
const path = require('path');
const router = express.Router();
const { requirePortalAuth } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { attachmentBuffer, attachmentAccessForFamily } = require('../utils/familySchool');
const { logError } = require('../utils/logger');

router.get('/family-school/files/:key', requirePortalAuth, async (req, res) => {
  const member = await memberForAccount(req.portalAccount.id);
  const access = await attachmentAccessForFamily(member ? member.family_id : null, req.params.key);
  if (!access) return res.status(404).send('Not found');
  // attachmentBuffer() can throw (Storage's own download() rejects with
  // a real error rather than returning null/undefined on a bucket/
  // object-level failure) - caught here, not left to bubble past this
  // route, since an uncaught rejection in an async Express handler never
  // reaches the app's own error middleware and just hangs the request
  // instead of showing a clean 404 the way every other failure here
  // does. console.error() first, same as every other real error in
  // this app (server.js's own error middleware/uncaughtException/
  // unhandledRejection handlers) - logError() alone no-ops on Netlify
  // (see its own comment), so skipping the console.error here would
  // make a real Storage-side problem (as opposed to a bad/stale key)
  // completely invisible in the Function log instead of just quietly
  // becoming "the image is broken."
  let buffer;
  try {
    buffer = await attachmentBuffer(req.params.key);
  } catch (err) {
    console.error(err);
    logError(`GET /family-school/files/${req.params.key}`, err);
    return res.status(404).send('Not found');
  }
  if (!buffer) return res.status(404).send('Not found');
  // nosniff (server.js's own global X-Content-Type-Options header) means
  // a missing Content-Type here isn't just cosmetic - Express's default
  // for a raw Buffer is application/octet-stream, which nosniff then
  // stops the browser from ever re-guessing back to "actually an image"
  // from the real bytes, so a logo/attachment with no mimetype on file
  // (predates the attachment_mime/logo_mime columns, or came from
  // somewhere that never captured one) would otherwise render as a
  // broken image with no error anywhere. Falling back to the uploaded
  // file's own extension covers that case the same way express.static
  // already would have.
  res.setHeader('Content-Type', access.mimeType || mimeFromKey(req.params.key));
  res.send(buffer);
});

const EXTENSION_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
function mimeFromKey(key) {
  const ext = path.extname(key || '').toLowerCase();
  return EXTENSION_MIME_TYPES[ext] || 'application/octet-stream';
}

module.exports = router;

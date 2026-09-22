const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { documentFileFilter, imageFileFilter, DOCUMENT_MIME_BY_EXT } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, downloadFile, generateKey, createSignedUploadUrl } = require('../utils/storage');

router.use(requireFullAdmin);

// `documents` is a *private* Supabase Storage bucket (see MIGRATION.md's
// bucket list) - management here still requires a full-admin login, even
// though a document itself can now be shared with a public link (see
// routes/documents.js, a separate unauthenticated router keyed off each
// document's own random public_token, never its id). When Supabase isn't
// configured (createStorageClient() returns null - the normal case for a
// local/LAN install), files still live on local disk exactly as before;
// documents.file_path/image_path store a bare key either way (matches
// utils/storage.js's own convention), so nothing downstream needs to know
// which backend actually stored it.
const DOCUMENTS_BUCKET = 'documents';

// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured (createStorageClient() below is cheap,
// no network call of its own - safe to call here just to check). Wrapped
// in try/catch: Storage being unconfigured (env vars missing/misscoped)
// used to mean this threw at require time and crashed the *entire* app
// (every route lives in one bundled function) before a single request
// could be served - now it only means local uploads fail on their own
// first write instead of taking every other route down with them.
const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
if (!createStorageClient() && !fs.existsSync(DOCUMENT_DIR)) {
  try {
    fs.mkdirSync(DOCUMENT_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${DOCUMENT_DIR}:`, err.message);
  }
}

// A real bug report: "When uploading documents on the admin side. It
// times out and says something went wrong. File doesn't upload." This
// app is deployed as one Netlify Function (see netlify.toml) - Netlify's
// own request-body ceiling for a standard function is ~6MB, so any
// document even a bit over that either gets rejected by the platform
// before ever reaching this route, or runs the Supabase Storage upload
// call right up against the function's execution timeout on a slow
// connection - both read to an admin as "times out."
//
// A later real request ("I can't upload larger files") confirmed the fix
// isn't a bigger number here - it's not going through this one function
// at all. public/js/document-upload.js now PUTs the file straight to
// Supabase Storage via a signed upload URL (POST /documents/upload-url
// below only ever sends/receives a filename and a key - never the file's
// bytes), then POSTs just the resulting key to /documents/upload-complete
// to write the DB row. This route (the plain multipart POST) stays in
// place ONLY as the fallback for a local/LAN install with no Supabase
// Storage configured (createStorageClient() null) - there's no
// serverless body ceiling to work around there, so its own limit is set
// generously instead of tuned to Netlify's constraint.
const LOCAL_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
function documentOrImageFileFilter(req, file, cb) {
  if (file.fieldname === 'image') return imageFileFilter(req, file, cb);
  return documentFileFilter(req, file, cb);
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOCAL_MAX_DOCUMENT_BYTES },
  fileFilter: documentOrImageFileFilter,
});

// A file over the limit above makes multer.single()/fields() itself throw
// a MulterError (LIMIT_FILE_SIZE) - unlike documentOrImageFileFilter
// rejecting a wrong file TYPE (which just leaves req.files undefined for
// the route's own "Please choose a PDF or Word file" branch to catch
// below), this error was never caught anywhere, so it fell all the way
// through to server.js's generic catch-all error handler and rendered the
// generic 500 page ("Something went wrong") - the exact text in the bug
// report - instead of the same friendly, specific redirect every other
// upload failure on this route already gets.
function uploadDocument(req, res, next) {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect(
        '/admin/documents?error=' +
          encodeURIComponent(`That file is too large - documents are limited to ${LOCAL_MAX_DOCUMENT_BYTES / (1024 * 1024)}MB on this install.`)
      );
    }
    next(err);
  });
}

function generatePublicToken() {
  return crypto.randomBytes(16).toString('hex');
}

router.get('/documents', async (req, res) => {
  const documents = await db.prepare('SELECT * FROM documents ORDER BY LOWER(title)').all();
  res.render('admin-documents', {
    title: 'Documents',
    documents,
    storageConfigured: !!createStorageClient(),
    publicOrigin: `${req.protocol}://${req.get('host')}`,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/documents/:id/view', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-document-view', { title: doc.title, doc, publicOrigin: `${req.protocol}://${req.get('host')}` });
});

router.get('/documents/:id/file', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).send('Not found');
  const client = createStorageClient();
  let buffer;
  if (client) {
    try {
      buffer = await downloadFile(client, DOCUMENTS_BUCKET, doc.file_path);
    } catch {
      return res.status(404).send('Not found');
    }
  } else {
    const filePath = path.join(DOCUMENT_DIR, doc.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    buffer = fs.readFileSync(filePath);
  }
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${doc.original_name.replace(/"/g, '')}"`);
  res.send(buffer);
});

// The admin-side counterpart to routes/documents.js's own public
// `/documents/:token/image` - same bytes, served through the
// requireFullAdmin gate instead, for the thumbnail on this page's own
// management list.
router.get('/documents/:id/image', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc || !doc.image_path) return res.status(404).send('Not found');
  const client = createStorageClient();
  let buffer;
  if (client) {
    try {
      buffer = await downloadFile(client, DOCUMENTS_BUCKET, doc.image_path);
    } catch {
      return res.status(404).send('Not found');
    }
  } else {
    const filePath = path.join(DOCUMENT_DIR, doc.image_path);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    buffer = fs.readFileSync(filePath);
  }
  res.setHeader('Content-Type', doc.image_mime_type || 'application/octet-stream');
  res.send(buffer);
});

// Step 1 of the direct-to-Storage upload (see LOCAL_MAX_DOCUMENT_BYTES's
// own comment above) - only ever exchanges a filename for a key and a
// short-lived signed URL, small enough that Netlify's function body
// ceiling never comes into play. Only available when Storage is actually
// configured; public/js/document-upload.js falls back to the plain
// multipart form (uploadDocument above) otherwise.
router.post('/documents/upload-url', async (req, res) => {
  const client = createStorageClient();
  if (!client) return res.status(501).json({ error: 'Direct upload is not available on this install.' });
  const filename = String(req.body.filename || 'file');
  try {
    const { key, uploadUrl } = await createSignedUploadUrl(client, DOCUMENTS_BUCKET, filename);
    res.json({ key, uploadUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2 - the browser has already PUT the file's (and optionally the
// image's) bytes straight to Storage; this just writes the DB row from
// the keys that upload produced. Never touches req.file/req.files.
router.post('/documents/upload-complete', async (req, res) => {
  const fileKey = req.body.fileKey;
  const fileOriginalName = (req.body.fileOriginalName || '').trim();
  if (!fileKey || !fileOriginalName) {
    return res.status(400).json({ error: 'Missing the uploaded file.' });
  }
  const title = (req.body.title || '').trim() || fileOriginalName.replace(/\.[^.]+$/, '');
  const ext = path.extname(fileOriginalName).toLowerCase();
  const mimeType = DOCUMENT_MIME_BY_EXT[ext] || req.body.fileMimeType || null;

  await db
    .prepare(
      `INSERT INTO documents (title, file_path, original_name, mime_type, image_path, image_mime_type, public_token) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, fileKey, fileOriginalName, mimeType, req.body.imageKey || null, req.body.imageMimeType || null, generatePublicToken());

  res.json({ redirect: '/admin/documents?notice=' + encodeURIComponent(`"${title}" uploaded.`) });
});

router.post('/documents/upload', uploadDocument, async (req, res) => {
  const fileUpload = req.files && req.files.file && req.files.file[0];
  const imageUpload = req.files && req.files.image && req.files.image[0];
  if (!fileUpload) {
    return res.redirect(
      '/admin/documents?error=' + encodeURIComponent('Please choose a PDF or Word file to upload.')
    );
  }
  const title = (req.body.title || '').trim() || fileUpload.originalname.replace(/\.[^.]+$/, '');
  const ext = path.extname(fileUpload.originalname).toLowerCase();
  const mimeType = DOCUMENT_MIME_BY_EXT[ext] || fileUpload.mimetype;

  // A real bug report: "when i try to upload documents... it goes to an
  // error page. nothing uploads." uploadFile() (utils/storage.js) throws
  // a plain Error on any Supabase Storage failure - a missing/misnamed
  // bucket, a bad SUPABASE_SERVICE_ROLE_KEY, whatever - and an uncaught
  // throw here fell straight through to server.js's generic catch-all
  // (Express 5 forwards a rejected async handler there automatically),
  // landing an admin on the same unhelpful "Something went wrong" page
  // regardless of what actually failed. Wrapping this in try/catch
  // surfaces the real underlying message instead.
  const client = createStorageClient();
  let fileKey;
  let imageKey = null;
  try {
    if (client) {
      fileKey = await uploadFile(client, DOCUMENTS_BUCKET, fileUpload.buffer, fileUpload.originalname, mimeType);
      if (imageUpload) imageKey = await uploadFile(client, DOCUMENTS_BUCKET, imageUpload.buffer, imageUpload.originalname, imageUpload.mimetype);
    } else {
      fileKey = generateKey(fileUpload.originalname);
      fs.writeFileSync(path.join(DOCUMENT_DIR, fileKey), fileUpload.buffer);
      if (imageUpload) {
        imageKey = generateKey(imageUpload.originalname);
        fs.writeFileSync(path.join(DOCUMENT_DIR, imageKey), imageUpload.buffer);
      }
    }
  } catch (err) {
    return res.redirect('/admin/documents?error=' + encodeURIComponent(`Upload failed: ${err.message}`));
  }

  await db
    .prepare(
      `INSERT INTO documents (title, file_path, original_name, mime_type, image_path, image_mime_type, public_token) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, fileKey, fileUpload.originalname, mimeType, imageKey, imageUpload ? imageUpload.mimetype : null, generatePublicToken());

  res.redirect('/admin/documents?notice=' + encodeURIComponent(`"${title}" uploaded.`));
});

router.post('/documents/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (doc) {
    const client = createStorageClient();
    if (client) {
      await deleteFile(client, DOCUMENTS_BUCKET, doc.file_path);
      if (doc.image_path) await deleteFile(client, DOCUMENTS_BUCKET, doc.image_path);
    } else {
      const filePath = path.join(DOCUMENT_DIR, doc.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (doc.image_path) {
        const imagePath = path.join(DOCUMENT_DIR, doc.image_path);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      }
    }
    await db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
  res.redirect('/admin/documents?notice=' + encodeURIComponent('Document deleted.'));
});

module.exports = router;

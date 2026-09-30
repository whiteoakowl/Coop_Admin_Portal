// Main Admin > Documents - a real request: "there should also be a page
// on main admin to upload the documents" (the existing upload page was
// Co-op Admin only - see routes/admin-documents.js). Shares the same
// `documents` table/bucket as Co-op Admin (there's only one shared
// document library, surfaced read-only on the Parent Portal via routes/
// parent-portal.js's own GET /documents), so this is the same management
// UI gated by Main Admin's own manage_documents permission instead of
// Co-op Admin's requireFullAdmin - see db/bootstrapPg.js's
// PORTAL_PERMISSIONS for that key.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');
const { documentFileFilter, imageFileFilter, DOCUMENT_MIME_BY_EXT } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, downloadFile, generateKey, createSignedUploadUrl } = require('../utils/storage');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_documents'));

const DOCUMENTS_BUCKET = 'documents';
const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
if (!createStorageClient() && !fs.existsSync(DOCUMENT_DIR)) {
  try {
    fs.mkdirSync(DOCUMENT_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${DOCUMENT_DIR}:`, err.message);
  }
}

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

function uploadDocument(req, res, next) {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }])(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect(
        '/main-admin/documents?error=' +
          encodeURIComponent(`That file is too large - documents are limited to ${LOCAL_MAX_DOCUMENT_BYTES / (1024 * 1024)}MB on this install.`)
      );
    }
    next(err);
  });
}

function generatePublicToken() {
  return crypto.randomBytes(16).toString('hex');
}

router.get('/', async (req, res) => {
  const documents = await db.prepare('SELECT * FROM documents ORDER BY LOWER(title)').all();
  res.render('main-admin-documents', {
    title: 'Documents',
    documents,
    storageConfigured: !!createStorageClient(),
    publicOrigin: `${req.protocol}://${req.get('host')}`,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/:id/view', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  res.render('main-admin-document-view', { title: doc.title, doc, publicOrigin: `${req.protocol}://${req.get('host')}` });
});

router.get('/:id/file', async (req, res) => {
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

router.get('/:id/image', async (req, res) => {
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

router.post('/upload-url', async (req, res) => {
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

router.post('/upload-complete', async (req, res) => {
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

  res.json({ redirect: '/main-admin/documents?notice=' + encodeURIComponent(`"${title}" uploaded.`) });
});

router.post('/upload', uploadDocument, async (req, res) => {
  const fileUpload = req.files && req.files.file && req.files.file[0];
  const imageUpload = req.files && req.files.image && req.files.image[0];
  if (!fileUpload) {
    return res.redirect(
      '/main-admin/documents?error=' + encodeURIComponent('Please choose a PDF or Word file to upload.')
    );
  }
  const title = (req.body.title || '').trim() || fileUpload.originalname.replace(/\.[^.]+$/, '');
  const ext = path.extname(fileUpload.originalname).toLowerCase();
  const mimeType = DOCUMENT_MIME_BY_EXT[ext] || fileUpload.mimetype;

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
    return res.redirect('/main-admin/documents?error=' + encodeURIComponent(`Upload failed: ${err.message}`));
  }

  await db
    .prepare(
      `INSERT INTO documents (title, file_path, original_name, mime_type, image_path, image_mime_type, public_token) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, fileKey, fileUpload.originalname, mimeType, imageKey, imageUpload ? imageUpload.mimetype : null, generatePublicToken());

  res.redirect('/main-admin/documents?notice=' + encodeURIComponent(`"${title}" uploaded.`));
});

router.post('/:id/delete', async (req, res) => {
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
  res.redirect('/main-admin/documents?notice=' + encodeURIComponent('Document deleted.'));
});

module.exports = router;

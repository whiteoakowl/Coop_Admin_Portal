const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { documentFileFilter, DOCUMENT_MIME_BY_EXT } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, downloadFile, generateKey } = require('../utils/storage');

router.use(requireFullAdmin);

// `documents` is a *private* Supabase Storage bucket (see MIGRATION.md's
// bucket list) - this route already gates every document behind
// requireFullAdmin above, and a public bucket would make that gate
// meaningless. When Supabase isn't configured (createStorageClient()
// returns null - the normal case for a local/LAN install), files still
// live on local disk exactly as before; documents.file_path stores a bare
// key either way (matches utils/storage.js's own convention), so nothing
// downstream needs to know which backend actually stored it.
const DOCUMENTS_BUCKET = 'documents';

// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured (createStorageClient() below is cheap,
// no network call of its own - safe to call here just to check).
const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
if (!createStorageClient() && !fs.existsSync(DOCUMENT_DIR)) fs.mkdirSync(DOCUMENT_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: documentFileFilter,
});

router.get('/documents', async (req, res) => {
  const documents = await db.prepare('SELECT * FROM documents ORDER BY LOWER(title)').all();
  res.render('admin-documents', {
    title: 'Documents',
    documents,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/documents/:id/view', async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-document-view', { title: doc.title, doc });
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

router.post('/documents/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect(
      '/admin/settings?tab=documents&error=' +
        encodeURIComponent('Please choose a PDF or Word file to upload.')
    );
  }
  const title = (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mimeType = DOCUMENT_MIME_BY_EXT[ext] || req.file.mimetype;

  const client = createStorageClient();
  let key;
  if (client) {
    key = await uploadFile(client, DOCUMENTS_BUCKET, req.file.buffer, req.file.originalname, mimeType);
  } else {
    key = generateKey(req.file.originalname);
    fs.writeFileSync(path.join(DOCUMENT_DIR, key), req.file.buffer);
  }

  await db.prepare(
    `INSERT INTO documents (title, file_path, original_name, mime_type) VALUES (?, ?, ?, ?)`
  ).run(title, key, req.file.originalname, mimeType);

  res.redirect('/admin/settings?tab=documents&notice=' + encodeURIComponent(`"${title}" uploaded.`));
});

router.post('/documents/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (doc) {
    const client = createStorageClient();
    if (client) {
      await deleteFile(client, DOCUMENTS_BUCKET, doc.file_path);
    } else {
      const filePath = path.join(DOCUMENT_DIR, doc.file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
  res.redirect('/admin/settings?tab=documents&notice=' + encodeURIComponent('Document deleted.'));
});

module.exports = router;

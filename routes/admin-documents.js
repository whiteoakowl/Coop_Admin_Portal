const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { documentFileFilter, DOCUMENT_MIME_BY_EXT } = require('../utils/uploads');

router.use(requireFullAdmin);

const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');
if (!fs.existsSync(DOCUMENT_DIR)) fs.mkdirSync(DOCUMENT_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCUMENT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: documentFileFilter,
});

router.get('/documents', (req, res) => {
  const documents = db.prepare('SELECT * FROM documents ORDER BY title COLLATE NOCASE').all();
  res.render('admin-documents', {
    title: 'Documents',
    documents,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/documents/:id/view', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  res.render('admin-document-view', { title: doc.title, doc });
});

router.get('/documents/:id/file', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!doc) return res.status(404).send('Not found');
  const filePath = path.join(DOCUMENT_DIR, doc.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${doc.original_name.replace(/"/g, '')}"`);
  res.sendFile(filePath);
});

router.post('/documents/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.redirect(
      '/admin/settings?tab=documents&error=' +
        encodeURIComponent('Please choose a PDF or Word file to upload.')
    );
  }
  const title = (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
  const ext = path.extname(req.file.originalname).toLowerCase();

  db.prepare(
    `INSERT INTO documents (title, file_path, original_name, mime_type) VALUES (?, ?, ?, ?)`
  ).run(title, req.file.filename, req.file.originalname, DOCUMENT_MIME_BY_EXT[ext] || req.file.mimetype);

  res.redirect('/admin/settings?tab=documents&notice=' + encodeURIComponent(`"${title}" uploaded.`));
});

router.post('/documents/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (doc) {
    const filePath = path.join(DOCUMENT_DIR, doc.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }
  res.redirect('/admin/settings?tab=documents&notice=' + encodeURIComponent('Document deleted.'));
});

module.exports = router;

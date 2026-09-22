// Public, unauthenticated document pages - a real request: "each
// document line should have a copy link button for easy public sharing,"
// confirmed to mean a document should be viewable by anyone with the
// link, no admin login required (e.g. handing a parent handbook to a
// prospective family). Deliberately its OWN router with no auth
// middleware at all, separate from routes/admin-documents.js's
// requireFullAdmin-gated management routes - mounted at /documents
// (server.js), so the link an admin copies is just /documents/<token>.
//
// Looked up by documents.public_token (a random string, not the row's
// own integer id) so this can't be used to enumerate every document on
// the site by incrementing a small number - same reasoning
// utils/portalAuth.js's own session tokens already use.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { createStorageClient, downloadFile } = require('../utils/storage');

const DOCUMENTS_BUCKET = 'documents';
const DOCUMENT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'documents');

async function loadByToken(token) {
  return db.prepare('SELECT * FROM documents WHERE public_token = ?').get(token);
}

async function streamKey(res, key, mimeType, filename) {
  const client = createStorageClient();
  let buffer;
  if (client) {
    try {
      buffer = await downloadFile(client, DOCUMENTS_BUCKET, key);
    } catch {
      return res.status(404).send('Not found');
    }
  } else {
    const filePath = path.join(DOCUMENT_DIR, key);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    buffer = fs.readFileSync(filePath);
  }
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  if (filename) res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  res.send(buffer);
}

router.get('/:token', async (req, res) => {
  const doc = await loadByToken(req.params.token);
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.render('public-document', { title: doc.title, doc, settings });
});

router.get('/:token/file', async (req, res) => {
  const doc = await loadByToken(req.params.token);
  if (!doc) return res.status(404).send('Not found');
  await streamKey(res, doc.file_path, doc.mime_type, doc.original_name);
});

router.get('/:token/image', async (req, res) => {
  const doc = await loadByToken(req.params.token);
  if (!doc || !doc.image_path) return res.status(404).send('Not found');
  await streamKey(res, doc.image_path, doc.image_mime_type);
});

module.exports = router;

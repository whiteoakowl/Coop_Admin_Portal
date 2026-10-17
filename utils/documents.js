// Shared `documents` table helpers - one document library, managed from
// both Main Admin and Co-op Admin (routes/main-admin-documents.js,
// routes/admin-documents.js) and surfaced read-only to members (Parent
// Portal's own GET /documents). A real request: "when clicking edit icon
// you can control which portals can view the documents" - document_roles
// is the same many-to-many, empty-means-everyone convention
// utils/resourceLinks.js's own resource_link_roles already established.
const db = require('../db');

async function roleKeysForDocument(documentId) {
  const rows = await db.prepare('SELECT role_key FROM document_roles WHERE document_id = ?').all(documentId);
  return rows.map((r) => r.role_key);
}

// Every document's own role keys in one query, keyed by document id - the
// admin management list (every document, one edit popup each) needs this
// for every row at once rather than one query per document.
async function roleKeysByDocument() {
  const rows = await db.prepare('SELECT document_id, role_key FROM document_roles').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.document_id)) map.set(r.document_id, []);
    map.get(r.document_id).push(r.role_key);
  }
  return map;
}

async function setDocumentRoleKeys(documentId, roleKeys) {
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM document_roles WHERE document_id = ?').run(documentId);
    for (const roleKey of roleKeys || []) {
      await tx.prepare('INSERT INTO document_roles (document_id, role_key) VALUES (?, ?) ON CONFLICT DO NOTHING').run(documentId, roleKey);
    }
  });
}

// Every document visible to a given portal role (an unscoped document -
// no document_roles rows at all - or one explicitly scoped to include
// this role) - what Parent Portal's own GET /documents reads instead of
// the unfiltered admin list.
async function listDocumentsForRole(roleKey) {
  return db
    .prepare(
      `SELECT d.id, d.title, d.image_path, d.public_token FROM documents d WHERE (
         NOT EXISTS (SELECT 1 FROM document_roles dr WHERE dr.document_id = d.id)
         OR EXISTS (SELECT 1 FROM document_roles dr WHERE dr.document_id = d.id AND dr.role_key = ?)
       ) ORDER BY LOWER(d.title)`
    )
    .all(roleKey);
}

module.exports = { roleKeysForDocument, roleKeysByDocument, setDocumentRoleKeys, listDocumentsForRole };

// Publications/Articles (Community & Commerce track, item 12). Body is
// sanitized server-side the same way Forums posts and the Newsletter
// are (utils/sanitizeHtml.js's sanitizePostBody()) - reusing the
// existing rich-text pattern rather than inventing a new one. Same
// visibility reasoning as utils/photos.js: defaults to 'members', and
// 'public' is a separate, deliberate choice.
const db = require('../db');
const { sanitizePostBody } = require('./sanitizeHtml');

async function listPublications({ status, visibility } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (visibility) {
    clauses.push('visibility = ?');
    params.push(visibility);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM publications ${where} ORDER BY COALESCE(published_at, created_at) DESC`).all(...params);
}

async function getPublication(id) {
  return db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
}

async function createDraft(title, accountId) {
  const info = await db.prepare('INSERT INTO publications (title, body_html, author_account_id) VALUES (?, ?, ?)').run(title, '', accountId);
  return info.lastInsertRowid;
}

async function updatePublication(id, { title, bodyHtml, visibility }) {
  await db
    .prepare('UPDATE publications SET title = ?, body_html = ?, visibility = ?, updated_at = now_text() WHERE id = ?')
    .run(title, sanitizePostBody(bodyHtml), visibility === 'public' ? 'public' : 'members', id);
}

async function publish(id) {
  await db.prepare("UPDATE publications SET status = 'published', published_at = now_text(), updated_at = now_text() WHERE id = ?").run(id);
}

async function unpublish(id) {
  await db.prepare("UPDATE publications SET status = 'draft', published_at = NULL, updated_at = now_text() WHERE id = ?").run(id);
}

async function deletePublication(id) {
  await db.prepare('DELETE FROM publications WHERE id = ?').run(id);
}

module.exports = { listPublications, getPublication, createDraft, updatePublication, publish, unpublish, deletePublication };

// Forums (Community & Commerce track, item 6): categories -> threads ->
// posts, moderation, and optional private class forums. See
// supabase/migrations/20260825060000_forums.sql for the schema this
// implements.
const db = require('../db');
const { sanitizePostBody } = require('./sanitizeHtml');

async function listCategories() {
  return db.prepare('SELECT c.*, cl.class_name FROM forum_categories c LEFT JOIN classes cl ON cl.id = c.class_id ORDER BY c.position, c.id').all();
}

async function getCategory(id) {
  return db.prepare('SELECT c.*, cl.class_name FROM forum_categories c LEFT JOIN classes cl ON cl.id = c.class_id WHERE c.id = ?').get(id);
}

async function createCategory(data) {
  const info = await db
    .prepare('INSERT INTO forum_categories (name, description, scope, class_id, position) VALUES (?, ?, ?, ?, ?)')
    .run(data.name, data.description || null, data.scope, data.scope === 'class' ? data.classId : null, data.position || 0);
  return info.lastInsertRowid;
}

async function setCategoryLocked(id, locked) {
  await db.prepare('UPDATE forum_categories SET is_locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
}

async function deleteCategory(id) {
  await db.prepare('DELETE FROM forum_categories WHERE id = ?').run(id);
}

// A 'general' category is open to any signed-in account, any role. A
// 'class' category is only open to that class's own teacher/assistants
// (class_staff), enrolled students (class_enrollments), or those
// students' own parents - who already appear in `family` alongside their
// enrolled child, since familyForAccount returns the whole family, not
// just the account's own member row. Read-only reference to Track A's
// class tables, never altered here.
async function canAccessCategory(category, family) {
  if (category.scope === 'general') return true;
  const memberIds = family.map((m) => m.id);
  if (!memberIds.length) return false;
  const placeholders = memberIds.map(() => '?').join(',');
  const staffMatch = await db.prepare(`SELECT 1 FROM class_staff WHERE class_id = ? AND member_id IN (${placeholders})`).get(category.class_id, ...memberIds);
  if (staffMatch) return true;
  const enrolledMatch = await db.prepare(`SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id IN (${placeholders})`).get(category.class_id, ...memberIds);
  return !!enrolledMatch;
}

async function accessibleCategories(family) {
  const all = await listCategories();
  const out = [];
  for (const c of all) {
    if (await canAccessCategory(c, family)) out.push(c);
  }
  return out;
}

// Threads sorted pinned-first, then by most recent activity (last post,
// or the thread's own creation if it somehow has none) - computed live
// from real post rows rather than a denormalized/cached "last activity"
// column that could drift.
// A real request: "this will then add their admin title label next to
// their name... when they post or comment in the chats." One admin can
// hold several positions (member_admin_positions, see utils/
// adminPositions.js) - string_agg'd into a single "President, Treasurer"
// label per author, same pattern as academics.js's own teacher_names.
// Null for a member who holds no admin position, same as authorName
// itself for a deleted member.
const ADMIN_TITLE_SUBQUERY = `(SELECT string_agg(ap.title, ', ' ORDER BY ap.position, LOWER(ap.title))
   FROM member_admin_positions map JOIN admin_positions ap ON ap.id = map.admin_position_id
   WHERE map.member_id = m.id) AS "authorAdminTitle"`;

async function listThreads(categoryId) {
  return db
    .prepare(
      `SELECT t.*, m.name AS "authorName", ${ADMIN_TITLE_SUBQUERY},
              COALESCE((SELECT MAX(p.created_at) FROM forum_posts p WHERE p.thread_id = t.id AND p.status = 'active'), t.created_at) AS "lastActivityAt",
              (SELECT COUNT(*) FROM forum_posts p WHERE p.thread_id = t.id AND p.status = 'active') AS "postCount"
       FROM forum_threads t
       LEFT JOIN members m ON m.id = t.member_id
       WHERE t.category_id = ?
       ORDER BY t.is_pinned DESC, "lastActivityAt" DESC`
    )
    .all(categoryId);
}

async function getThread(id) {
  return db
    .prepare(`SELECT t.*, m.name AS "authorName", ${ADMIN_TITLE_SUBQUERY} FROM forum_threads t LEFT JOIN members m ON m.id = t.member_id WHERE t.id = ?`)
    .get(id);
}

async function createThread(categoryId, title, bodyHtml, memberId, accountId) {
  const threadInfo = await db.prepare('INSERT INTO forum_threads (category_id, title, member_id, account_id) VALUES (?, ?, ?, ?)').run(categoryId, title, memberId, accountId);
  const threadId = threadInfo.lastInsertRowid;
  await db.prepare('INSERT INTO forum_posts (thread_id, member_id, account_id, body_html) VALUES (?, ?, ?, ?)').run(threadId, memberId, accountId, sanitizePostBody(bodyHtml));
  return threadId;
}

async function listPosts(threadId) {
  return db
    .prepare(
      `SELECT p.*, m.name AS "authorName", ${ADMIN_TITLE_SUBQUERY} FROM forum_posts p
       LEFT JOIN members m ON m.id = p.member_id
       WHERE p.thread_id = ? ORDER BY p.created_at`
    )
    .all(threadId);
}

async function addPost(threadId, bodyHtml, memberId, accountId) {
  const info = await db.prepare('INSERT INTO forum_posts (thread_id, member_id, account_id, body_html) VALUES (?, ?, ?, ?)').run(threadId, memberId, accountId, sanitizePostBody(bodyHtml));
  await db.prepare('UPDATE forum_threads SET updated_at = now_text() WHERE id = ?').run(threadId);
  return info.lastInsertRowid;
}

async function getPost(id) {
  return db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(id);
}

async function editPost(id, bodyHtml) {
  await db.prepare("UPDATE forum_posts SET body_html = ?, updated_at = now_text(), edited_at = now_text() WHERE id = ?").run(sanitizePostBody(bodyHtml), id);
}

// --- Moderation (handoff's own "an audit trail for moderation actions"
// requirement - every one of these writes a forum_moderation_actions
// row, not just the state change itself). ---

async function logModeration(actorAccountId, action, targetType, targetId, detail) {
  await db.prepare('INSERT INTO forum_moderation_actions (actor_account_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)').run(actorAccountId, action, targetType, targetId, detail || null);
}

async function removePost(id, actorAccountId) {
  await db.prepare("UPDATE forum_posts SET status = 'removed', updated_at = now_text() WHERE id = ?").run(id);
  await logModeration(actorAccountId, 'remove', 'post', id, null);
}

async function restorePost(id, actorAccountId) {
  await db.prepare("UPDATE forum_posts SET status = 'active', updated_at = now_text() WHERE id = ?").run(id);
  await logModeration(actorAccountId, 'restore', 'post', id, null);
}

async function setThreadPinned(id, pinned, actorAccountId) {
  await db.prepare('UPDATE forum_threads SET is_pinned = ?, updated_at = now_text() WHERE id = ?').run(pinned ? 1 : 0, id);
  await logModeration(actorAccountId, pinned ? 'pin' : 'unpin', 'thread', id, null);
}

async function setThreadLocked(id, locked, actorAccountId) {
  await db.prepare('UPDATE forum_threads SET is_locked = ?, updated_at = now_text() WHERE id = ?').run(locked ? 1 : 0, id);
  await logModeration(actorAccountId, locked ? 'lock' : 'unlock', 'thread', id, null);
}

async function setThreadArchived(id, archived, actorAccountId) {
  await db.prepare("UPDATE forum_threads SET status = ?, updated_at = now_text() WHERE id = ?").run(archived ? 'archived' : 'active', id);
  await logModeration(actorAccountId, archived ? 'archive' : 'unarchive', 'thread', id, null);
}

async function moveThread(id, newCategoryId, actorAccountId) {
  await db.prepare('UPDATE forum_threads SET category_id = ?, updated_at = now_text() WHERE id = ?').run(newCategoryId, id);
  await logModeration(actorAccountId, 'move', 'thread', id, `to category ${newCategoryId}`);
}

async function logEdit(actorAccountId, postId) {
  await logModeration(actorAccountId, 'edit', 'post', postId, null);
}

// A real request (Main Admin Chat's own Archive tab): "main admin portal
// chat should have the tabs new chat, moderate, archive." Categories
// themselves have no archive concept - only a hard delete ("this removes
// every thread and post in it") - but individual THREADS already do
// (forum_threads.status, set by routes/forums.js's own member-facing
// archive/unarchive buttons via setThreadArchived above), so the Archive
// tab surfaces exactly that: every thread any member or moderator has
// archived, across every category, with a way to restore it.
async function archivedThreads() {
  return db
    .prepare(
      `SELECT t.*, m.name AS "authorName", c.name AS "categoryName", c.id AS "categoryId"
       FROM forum_threads t
       LEFT JOIN members m ON m.id = t.member_id
       LEFT JOIN forum_categories c ON c.id = t.category_id
       WHERE t.status = 'archived'
       ORDER BY t.updated_at DESC`
    )
    .all();
}

async function moderationLog(limit = 100) {
  return db
    .prepare(
      `SELECT a.*, ma.name AS "memberName" FROM forum_moderation_actions a
       LEFT JOIN member_accounts mac ON mac.id = a.actor_account_id
       LEFT JOIN members ma ON ma.id = mac.member_id
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  listCategories,
  getCategory,
  createCategory,
  setCategoryLocked,
  deleteCategory,
  canAccessCategory,
  accessibleCategories,
  listThreads,
  getThread,
  createThread,
  listPosts,
  addPost,
  getPost,
  editPost,
  removePost,
  restorePost,
  setThreadPinned,
  setThreadLocked,
  setThreadArchived,
  moveThread,
  logEdit,
  archivedThreads,
  moderationLog,
};

// Student Portal > Nature News - a real request: "students can submit
// descriptions and one image of something they discovered in nature...
// main admin must approve. then it will appear on student portal
// homepage... only show up on everyone's student portal after they have
// been approved." Same pending/approved/rejected review shape as
// utils/photos.js/utils/babysitters.js - see this migration's own
// header comment (20260830050000_nature_news.sql).
const db = require('../db');

async function submitPost(memberId, description, imageKey) {
  const cleanDescription = (description || '').trim().slice(0, 1000);
  if (!cleanDescription) return { ok: false, error: 'Please describe what you discovered.' };
  if (!imageKey) return { ok: false, error: 'Please attach a photo.' };
  await db
    .prepare('INSERT INTO nature_news_posts (member_id, description, image_key) VALUES (?, ?, ?)')
    .run(memberId, cleanDescription, imageKey);
  return { ok: true };
}

async function postsForMember(memberId) {
  return db.prepare('SELECT * FROM nature_news_posts WHERE member_id = ? ORDER BY created_at DESC').all(memberId);
}

async function getPost(id) {
  return db.prepare('SELECT * FROM nature_news_posts WHERE id = ?').get(id);
}

async function listPending() {
  return db
    .prepare(
      `SELECT p.*, m.name AS member_name FROM nature_news_posts p
       JOIN members m ON m.id = p.member_id
       WHERE p.status = 'pending' ORDER BY p.created_at`
    )
    .all();
}

// Homepage card - "a card called nature news that shows the last 3 posts
// students have made" - approved only, newest first.
async function listApproved(limit = 3) {
  return db
    .prepare(
      `SELECT p.*, m.name AS member_name FROM nature_news_posts p
       JOIN members m ON m.id = p.member_id
       WHERE p.status = 'approved' ORDER BY p.decided_at DESC, p.created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

async function decide(id, approve, accountId) {
  await db
    .prepare("UPDATE nature_news_posts SET status = ?, decided_at = now_text(), decided_by_account_id = ? WHERE id = ?")
    .run(approve ? 'approved' : 'rejected', accountId, id);
}

module.exports = {
  submitPost,
  postsForMember,
  getPost,
  listPending,
  listApproved,
  decide,
};

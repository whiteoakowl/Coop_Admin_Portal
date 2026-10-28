// Route-level coverage for the Forums pagination added across routes/
// admin-forums.js and routes/forums.js (the "ongoing lists and logs
// should paginate" cluster - see utils/pagination.js for the shared
// convention this follows). Two things worth a dedicated test, distinct
// from test/pagination.test.js's own math coverage:
//
//   - A plain list (a category's thread list) pages like every other
//     admin list in the app - default page 1, utils/pagination.js's own
//     DEFAULT_PAGE_SIZE=50.
//   - A thread's post feed is long-lived, chat-like history - it
//     defaults to the LAST page (its newest posts) instead of page 1
//     when no ?page= is given, but an explicit ?page=1 still reaches the
//     oldest posts same as any other paginated list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `forums-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `forums-pagination-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createCategory(admin, name) {
  const res = await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name, scope: 'general', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  const row = await db.prepare('SELECT id FROM forum_categories WHERE name = ?').get(name);
  return row.id;
}

// Direct DB inserts (not one HTTP round-trip per row) with explicit,
// strictly increasing created_at timestamps - same reasoning as other
// pagination tests' own seed helpers (e.g. test/routes-logs-pagination.
// test.js): fast, and avoids every row landing on the exact same
// now_text() second, which would otherwise make ORDER BY created_at's
// tie-break (there isn't one) unreliable. now_text()'s own format is
// "YYYY-MM-DD HH:MM:SS" (a space, not "T") - utils/dates.js's own
// formatChatTimestamp (listPosts runs every row through it) assumes
// that shape and appends its own "Z", so a plain ISO string here would
// double up on it and throw.
function sqlTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

async function seedThreads(categoryId, count) {
  for (let i = 1; i <= count; i++) {
    const createdAt = sqlTimestamp(Date.now() + i * 1000);
    await db.prepare('INSERT INTO forum_threads (category_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(categoryId, `Thread ${i}`, createdAt, createdAt);
  }
}

async function seedThreadWithPosts(categoryId, replyCount) {
  const baseTime = Date.now();
  const threadInfo = await db
    .prepare('INSERT INTO forum_threads (category_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(categoryId, 'Long Thread', sqlTimestamp(baseTime), sqlTimestamp(baseTime));
  const threadId = threadInfo.lastInsertRowid;
  await db.prepare('INSERT INTO forum_posts (thread_id, body_html, created_at) VALUES (?, ?, ?)').run(threadId, '<p>Original post body</p>', sqlTimestamp(baseTime));
  for (let i = 1; i <= replyCount; i++) {
    await db.prepare('INSERT INTO forum_posts (thread_id, body_html, created_at) VALUES (?, ?, ?)').run(threadId, `<p>Reply ${i}</p>`, sqlTimestamp(baseTime + i * 1000));
  }
  return threadId;
}

test('a category thread list paginates once there are more than a page of threads', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createCategory(admin, 'Pagination Test Group');
  await seedThreads(categoryId, 55);

  const page1 = await request(app).get(`/main-admin/forums/${categoryId}`).set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assert.match(page1.text, /Showing 1&ndash;50 of 55/);

  const page2 = await request(app).get(`/main-admin/forums/${categoryId}?page=2`).set('Cookie', admin.cookie);
  assert.equal(page2.status, 200);
  assert.match(page2.text, /Showing 51&ndash;55 of 55/);
});

test('a thread with more than a page of posts defaults to its newest page, but an explicit page=1 still reaches the oldest', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createCategory(admin, 'Pagination Test Long Thread Group');
  // 1 original post + 54 replies = 55 posts, DEFAULT_PAGE_SIZE=50 - page
  // 1 holds the original post through Reply 49; page 2 holds Reply 50-54.
  const threadId = await seedThreadWithPosts(categoryId, 54);

  const defaultView = await request(app).get(`/main-admin/forums/threads/${threadId}`).set('Cookie', admin.cookie);
  assert.equal(defaultView.status, 200);
  assert.match(defaultView.text, /Reply 54/, 'no ?page= should default to the last page - the newest reply');
  assert.doesNotMatch(defaultView.text, /Original post body/, 'the original post is on page 1, not the default (last) page');

  const page1View = await request(app).get(`/main-admin/forums/threads/${threadId}?page=1`).set('Cookie', admin.cookie);
  assert.equal(page1View.status, 200);
  assert.match(page1View.text, /Original post body/, 'an explicit ?page=1 should still reach the oldest post');
  assert.doesNotMatch(page1View.text, /Reply 54/, 'page 1 should not include the newest reply');
});

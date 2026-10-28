// Route-level coverage for Main Admin's Nature News review queue
// (mounted at /main-admin/nature-news - routes/admin-nature-news.js).
// See utils/natureNews.js's own header comment for the pending/
// approved/rejected shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-nature-news-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-nature-news-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('admin nature news requires sign-in', async () => {
  const res = await request(app).get('/main-admin/nature-news');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

// Pagination (Phase 4 audit item) - "Recently Approved" used to be
// hard-capped at listApproved(20), silently truncating anything beyond
// the 20 newest posts. That cap is now real pagination (utils/
// pagination.js), same as every other ongoing list/log.
test('Recently Approved is paginated, page 1 shows only the first page of approved posts', async () => {
  const cookie = await loginAsMainAdmin();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)")
    .run('Nature News Poster', 'NNP-1');
  const memberId = memberInfo.lastInsertRowid;

  for (let i = 0; i < 55; i += 1) {
    await db
      .prepare("INSERT INTO nature_news_posts (member_id, description, image_key, status, decided_at) VALUES (?, ?, ?, 'approved', now_text())")
      .run(memberId, `Discovery number ${i}`, `key-${i}`);
  }

  const page1 = await request(app).get('/main-admin/nature-news').set('Cookie', cookie);
  assert.equal(page1.status, 200);
  assert.equal((page1.text.match(/Discovery number \d+/g) || []).length, 50, 'page 1 should show only the default 50-item page, not every approved post');
  assert.match(page1.text, /class="pagination-bar no-print"/, 'pagination controls should render once there is more than one page');
  assert.match(page1.text, /Showing 1&ndash;50 of 55/);

  const page2 = await request(app).get('/main-admin/nature-news?page=2').set('Cookie', cookie);
  assert.equal(page2.status, 200);
  assert.equal((page2.text.match(/Discovery number \d+/g) || []).length, 5, 'page 2 should show the remaining 5 approved posts');
});

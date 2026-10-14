// Real bug report: "Main admin portal, category/fiscal year page. After
// adding 4 categories it asks me to log in and then goes to 404 page."
// A session that expires mid-use (cookie cleared, session row swept,
// etc.) hits requirePortalAuth/requirePortal/requirePortalPermission
// (middleware/portalAuth.js) or requireAdmin/requireFullAdmin
// (middleware/requireAdmin.js, requireFullAdmin.js) on its NEXT request.
// Those used to always set `next=` to the request's own URL and redirect
// to /login - fine for a GET, but for a POST (an add/edit/delete form's
// own write-only action URL, e.g. POST /main-admin/accounting/
// accounting-categories, which has no GET handler at all) following
// `next` with a plain GET after logging back in 404s outright. The fix:
// `next` is only carried forward for a GET request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `login-redirect-post-safe-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `login-redirect-post-safe-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('requireAdmin: an unauthenticated POST to a write-only admin action URL redirects to login with no next= (would 404 on replay)', async () => {
  const res = await request(app).post('/admin/announcements/email/send').type('form').send({});
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/login');
});

test('requireAdmin: an unauthenticated GET still carries next= (replaying it with GET is safe)', async () => {
  const res = await request(app).get('/admin/announcements');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/admin/login?next=${encodeURIComponent('/admin/announcements')}`);
});

test('requirePortalAuth/requirePortal/requirePortalPermission: an unauthenticated POST to a write-only Main Admin action URL redirects to login with no next=', async () => {
  const res = await request(app).post('/main-admin/accounting/accounting-categories').type('form').send({ name: 'Test Category' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('requirePortalAuth/requirePortal/requirePortalPermission: an unauthenticated GET still carries next=', async () => {
  const res = await request(app).get('/main-admin/accounting/categories');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/login?next=${encodeURIComponent('/main-admin/accounting/categories')}`);
});

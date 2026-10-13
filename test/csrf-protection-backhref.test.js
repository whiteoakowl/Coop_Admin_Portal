// A real bug report: "Main admin portal, event, creating tickets...
// somewhere it jumps back to co-op admin portal." Traced to
// middleware/csrfProtection.js's own 403 render on a CSRF mismatch (e.g.
// a stale token after the event builder page was left open a while) -
// it was the only res.status(403).render('403', ...) call in the whole
// app that left backHref/backLabel unset, so it fell through to views/
// 403.ejs's own hardcoded '/admin' default. That default is correct for
// the single shared Co-op Admin login, but a member portal account
// (Main Admin/Parent/Student/Teacher) has no access to '/admin' at all -
// clicking "Back to Dashboard" there lands a Main Admin on the Co-op
// Admin dashboard instead of their own portal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `csrf-protection-backhref-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `csrf-protection-backhref-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('A CSRF mismatch on a Main Admin portal action sends "Back to My Portals" to /portal, not the Co-op Admin dashboard', async () => {
  const cookie = await loginAsMainAdmin();
  // No _csrf field at all - the same mismatch a stale/expired token on a
  // long-open page (like the event builder's Finance tab) would produce.
  const res = await request(app)
    .post('/main-admin/events/categories')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Should Be Rejected' });
  assert.equal(res.status, 403);
  assert.match(res.text, /href="\/portal"/);
  assert.match(res.text, />Back to My Portals</);
  assert.doesNotMatch(res.text, /href="\/admin"/);
});

test('A CSRF mismatch on a Co-op Admin action still sends "Back to Dashboard" to /admin', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app)
    .post('/admin/settings/username')
    .set('Cookie', cookie)
    .type('form')
    .send({ username: 'shouldnotchange' });
  assert.equal(res.status, 403);
  assert.match(res.text, /href="\/admin"/);
  assert.match(res.text, />Back to Dashboard</);
});

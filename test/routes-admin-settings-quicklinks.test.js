// Real HTTP-level coverage for Settings' Quick Links tab (routes/admin.js's
// GET /settings?tab=quicklinks, views/admin-settings.ejs). A real bug
// report: "the quick link for setup/cleanup assignments should link to
// the member kiosk view of setup/cleanup. same with the floater
// assignment quick link." - both used to point at the admin-only
// management pages (/admin/setup, /admin/volunteers) instead of the
// public, no-login member-facing kiosk views (/setup, /volunteers -
// routes/setup.js and routes/volunteers.js's own bare GET routes, both
// already used elsewhere as quick-glance kiosk screens).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-settings-quicklinks-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-settings-quicklinks-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Quick Links: Setup/Cleanup Teams and Floater Assignments point at the member kiosk views, not the admin management pages', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/settings?tab=quicklinks').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /<a class="admin-card" href="\/setup" target="_blank">Setup\/Cleanup Teams<\/a>/);
  assert.match(res.text, /<a class="admin-card" href="\/volunteers" target="_blank">Floater Assignments<\/a>/);

  // Scoped to the Quick Links card grid itself - the admin nav sidebar on
  // this same page legitimately links to /admin/setup and /admin/volunteers
  // (the actual admin management tabs), so a page-wide doesNotMatch would
  // be a false negative.
  const gridStart = res.text.indexOf('admin-card-grid');
  const gridEnd = res.text.indexOf('</div>', gridStart);
  const gridHtml = res.text.slice(gridStart, gridEnd);
  assert.doesNotMatch(gridHtml, /href="\/admin\/setup"/, 'should no longer link to the admin-only management page');
  assert.doesNotMatch(gridHtml, /href="\/admin\/volunteers"/, 'should no longer link to the admin-only management page');
});

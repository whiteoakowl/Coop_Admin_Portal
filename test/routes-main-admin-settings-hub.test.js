// Coverage for a real request: "main admin portal, settings. clicking on
// the tab settings tab on the dashboard should not show subpages.
// instead all subpages should be rows of cards for each setting
// category." routes/main-admin.js's GET /settings used to redirect
// straight to /main-admin/roles (and views/partials/portal-nav.ejs's own
// gear icon used to open a .portal-switcher-details dropdown of 4 of
// these same destinations right in the sidebar); now the gear is a plain
// link like every other portal's, and /main-admin/settings itself renders
// a real landing page - one card per settings-area destination.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-settings-hub-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-settings-hub-test-uploads-${process.pid}`);
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

test('GET /main-admin/settings renders a card for every settings-area destination, not a redirect', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Settings<\/h1>/);

  assert.match(res.text, /href="\/main-admin\/roles"[^]*?Roles &amp; Permissions/);
  assert.match(res.text, /href="\/main-admin\/admins"[^]*?Admins/);
  assert.match(res.text, /href="\/main-admin\/website"[^]*?Website/);
  assert.match(res.text, /href="\/main-admin\/faq"[^]*?FAQ/);
  assert.match(res.text, /href="\/main-admin\/quick-links"[^]*?Quick Links/);
  assert.match(res.text, /href="\/main-admin\/audit-log"[^]*?Audit Log/);
  assert.match(res.text, /href="\/admin"[^]*?Co-op Admin Portal/);
});

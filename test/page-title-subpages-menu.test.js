// Coverage for a real request: "on mobile add a fit to text drop down
// menu next to each page title with the subpages as a secondary way of
// accessing the subpages." public/js/page-tabs.js inserts a second
// trigger next to a page's own <h1>, opening the SAME dialog its section's
// orange-bar trigger already does - this is markup/route-level coverage
// only (server-rendered contract); the actual open/close/outside-click
// interaction between the two triggers sharing one dialog was verified
// with a real headless-Chromium session during development (a genuine
// bug: the outside-click handler used to key one trigger per dialog, so
// opening via the new trigger looked like an outside click to the
// orange-bar trigger's own pair and immediately re-closed it - fixed by
// keying triggersByDialog as dialog -> every trigger that opens it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `page-title-subpages-menu-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `page-title-subpages-menu-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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

test('page-tabs.js is loaded on every page that has subpages-bearing sections, so the page-title trigger it inserts is available', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<script src="\/js\/page-tabs\.js"><\/script>/);
  // The dialog it will attach the new trigger to is present in the
  // shared nav shell on every page, per-section, not just this one.
  assert.match(res.text, /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-members">/);
});

test('CSS ships a mobile-only page-title trigger style, hidden on desktop', async () => {
  const res = await request(app).get('/css/styles.css');
  assert.equal(res.status, 200);
  assert.match(res.text, /\.page-title-subpages-trigger/);
  assert.match(res.text, /@media \(min-width: 861px\) \{\s*\.page-title-subpages-trigger \{ display: none; \}/);
});

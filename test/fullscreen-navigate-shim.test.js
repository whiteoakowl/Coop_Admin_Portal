// A real bug report: "dropdown search on member page, main admin or
// co-op admin, should automatically show that member. Currently nothing
// is happening." Traced to window.fullscreenNavigate(this.value) on the
// Filter dropdown's <select onchange> - public/js/fullscreen-nav.js (the
// real implementation) is a kiosk-only script, never loaded on an admin
// page, so calling it threw "window.fullscreenNavigate is not a
// function" and the dropdown silently did nothing. The exact same
// onchange="window.fullscreenNavigate(...)" pattern turned out to be
// copied onto a Filter/date-picker dropdown on a dozen OTHER admin pages
// too (admin-design, admin-library, admin-logs, admin-name-tag, admin-
// rosters, admin-setup-archive, admin-setup-assignments, admin-
// volunteer-archive, admin-volunteers, main-admin-name-tags) - all
// equally broken, none of them kiosk pages.
//
// Rather than one test per affected view (which would need to be
// updated every time a new page copies this same dropdown pattern), this
// covers the actual fix point: both shared nav shells (partials/admin-
// nav.ejs for Co-op Admin, partials/portal-nav.ejs for Main Admin/every
// other portal) now load a tiny fallback shim (public/js/fullscreen-
// navigate-shim.js) that defines window.fullscreenNavigate as a plain
// navigation whenever the real kiosk implementation isn't present - so
// ANY admin/portal page's dropdown, present or future, degrades to a
// working plain navigation instead of a silent no-op.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fullscreen-navigate-shim-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fullscreen-navigate-shim-test-uploads-${process.pid}`);
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

test('Co-op Admin pages (partials/admin-nav.ejs) load the fullscreenNavigate fallback shim', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<script src="\/js\/fullscreen-navigate-shim\.js"><\/script>/);
  // The Members page's own Filter dropdown really does still rely on it -
  // confirms this page is a real consumer, not just a page that happens
  // to load the shim unused.
  assert.match(res.text, /onchange="window\.fullscreenNavigate\(this\.value\)"/);
});

test('Main Admin / portal pages (partials/portal-nav.ejs) load the fullscreenNavigate fallback shim', async () => {
  const loginRes = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123', next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];

  // Not /main-admin/members any more - its own Filter dropdown became a
  // button+popup (a real request: "filter dropdown should change to an
  // orange button with a popup"), which submits via a plain <form> GET,
  // not fullscreenNavigate. Name Tags' own Requests tab date picker
  // still uses it, confirming this is a real, live consumer page.
  const res = await request(app).get('/main-admin/name-tags?tab=requests').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<script src="\/js\/fullscreen-navigate-shim\.js"><\/script>/);
  assert.match(res.text, /onchange="window\.fullscreenNavigate\(/);
});

test('the shim script itself only defines window.fullscreenNavigate when nothing already has', async () => {
  const res = await request(app).get('/js/fullscreen-navigate-shim.js');
  assert.equal(res.status, 200);
  assert.match(res.text, /if \(!window\.fullscreenNavigate\)/, 'must never override a real kiosk page\'s own fullscreen-nav.js implementation');
});

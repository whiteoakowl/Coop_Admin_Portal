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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
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

// A real bug report: "co-op main menu, library page should have blue
// bubble dropdown menu next to title for subpages. Same for logs page.
// Same for classes page." public/js/page-tabs.js's own
// findCurrentSectionDialog can only ever find a match by comparing the
// CURRENT url against each subpage link's own href - either the same
// query params, or (its fallback) a bare href with no query string
// matched against an equally bare current URL. Library/Logs/Classes'
// own routes each render their default tab at the bare URL (no ?tab=)
// without ever redirecting the address bar to the "real" one - so as
// long as every single subpage link for that section carried its own
// ?tab=, none of them could ever match that bare URL, and the trigger
// this test's own sibling above proves exists in page-tabs.js never
// actually found a dialog to attach itself to. Matches the Shop/
// Communication convention (already working) of a bare href on
// whichever one subpage really is the route's own default.
test('Library/Logs/Classes each have a bare (no ?tab=) default subpage, matching their own route\'s actual default-tab behavior', async () => {
  const cookie = await loginAsCoopAdmin();
  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /<a href="\/admin\/library">Check In<\/a>/, 'Library\'s own default subpage must be bare - routes/admin-library.js renders Check In at the bare URL');
  assert.doesNotMatch(res.text, /<a href="\/admin\/library\?tab=checkin">/, 'no subpage link should still point at the old, never-matchable ?tab=checkin form');

  assert.match(res.text, /<a href="\/admin\/logs">Absence\/Late Log<\/a>/, 'Logs\' own default subpage must be bare - routes/admin-logs.js renders Absence/Late at the bare URL');
  assert.doesNotMatch(res.text, /<a href="\/admin\/logs\?tab=absence">/);

  assert.match(res.text, /<a href="\/admin\/schedule">Class Schedules<\/a>/, 'Classes\' own default subpage must be bare - routes/admin-schedule.js renders Monday at the bare URL');
  assert.doesNotMatch(res.text, /<a href="\/admin\/schedule\?tab=monday">/);
});

test('visiting Library/Logs/Classes at their own bare default URL now has a matching mobile-subpages dialog to attach the page-title Menu trigger to', async () => {
  const cookie = await loginAsCoopAdmin();

  for (const [url, dialogId] of [
    ['/admin/library', 'mobile-subpages-library'],
    ['/admin/logs', 'mobile-subpages-logs'],
    ['/admin/schedule', 'mobile-subpages-classes'],
  ]) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, url);
    const dialogMatch = new RegExp(`<dialog class="view-tabs page-tabs-dialog no-print" id="${dialogId}">([\\s\\S]*?)</dialog>`).exec(res.text);
    assert.ok(dialogMatch, `${url} should render its own section's mobile-subpages dialog (${dialogId})`);
    // The bare current URL must appear, unmodified, as one of this
    // dialog's own links - the exact match public/js/page-tabs.js's own
    // findCurrentSectionDialog needs (or its fallback) to find this
    // dialog from this page.
    assert.match(dialogMatch[1], new RegExp(`href="${url.replace(/\//g, '\\/')}"`), `${url}'s own dialog must list this exact bare URL as one of its subpage links`);
  }
});

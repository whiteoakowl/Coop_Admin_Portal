// Real HTTP-level coverage for a bug report: "printing setup cleanup team
// produces something different on the desktop then if you printed on
// mobile." Traced to public/css/styles.css's `@media print { .admin-main
// { max-width: none; ... } }` - correct as far as it goes (drops the
// on-screen sidebar-reserving max-width), but still left .admin-main's
// actual print WIDTH to whatever ambient viewport the browser's print
// pipeline happened to use. Desktop browsers lay that out against the
// PAPER's own content width (each page's own inline `@page { margin }`),
// but mobile Safari/Chrome's print pipeline is documented to render at
// the phone's on-screen viewport width instead and scale the whole
// result to fit the page afterward - so the SAME "2 cards per row" grid
// came out at wildly different absolute proportions (cramped/tiny on a
// phone, normal on desktop) even though the grid's own column math was
// identical either way (verified live via Playwright while diagnosing
// this: gridTemplateColumns matched, but rendered card width didn't).
//
// The fix pins the four "the live page prints itself directly - no
// dedicated print-preview route" pages (Setup/Cleanup Teams, Setup/
// Cleanup Assignments, Floater Teams, Floater Assignments) to an
// EXPLICIT physical width at print time, scoped via a body class per
// page (matching each page's own @page margin) rather than a blanket
// change to the widely-shared .admin-main class, which would also wrap
// every .badge-sheet-page/.print-page bulk-print route that already
// sizes its own print surface explicitly and doesn't share these four
// pages' single-@page-margin assumption.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `print-page-width-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `print-page-width-test-uploads-${process.pid}`);
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

test('the four "prints itself, no preview route" pages carry a print-width-scoping body class', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('Setup/Cleanup Teams (admin-setup.ejs)', async () => {
    const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<body class="admin-page setup-teams-print-page">/);
  });

  await t.test('Setup/Cleanup Assignments (admin-setup-assignments.ejs)', async () => {
    const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<body class="admin-page setup-assignments-print-page">/);
  });

  await t.test('Floater Teams (admin-volunteer-teams.ejs)', async () => {
    const res = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<body class="admin-page floater-teams-print-page">/);
  });

  await t.test('Floater Assignments (admin-volunteers.ejs)', async () => {
    const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<body class="admin-page floater-assignments-print-page">/);
  });
});

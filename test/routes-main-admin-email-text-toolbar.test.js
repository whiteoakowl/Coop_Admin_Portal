// A real request: "email tab, add and select all and select none check
// boxes. neatly on the same row. create email and filter button should be
// on the same row, same size, text fit in the button, clean and
// professional. same with text tab." Main Admin's Email/Text tabs had
// moved to a single combined checkbox in the table header, then to a
// Select All/Select None checkbox pair in their own toolbar row, then to
// just Select All after "remove select none option."
//
// A later real request reversed course again: "Remove select all and
// select none buttons. Instead put a check box on the title row of the
// 1st column. Selecting this box checks everyone. Unchecking that box
// unchecks everyone." Select All is back in the table's own header cell
// (see test/routes-communication-email.test.js/routes-communication-
// text.test.js for the full select-all-checkbox behavior) - Filter/Create
// Email/Text are the toolbar's only buttons now, both plain
// .roster-action-btn, same class/size.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-email-text-toolbar-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-email-text-toolbar-test-uploads-${process.pid}`);
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

function checkToolbar(text) {
  const rows = [...text.matchAll(/<div class="roster-btn-row email-toolbar-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(rows.length, 1, 'expected a single email-toolbar-row div - Select All no longer gets its own row');
  const filterRow = rows[0];
  assert.match(filterRow, /class="roster-action-btn" onclick="document\.getElementById\('email-filter-dialog'\)\.showModal\(\)">Filter</);
  // Create Email/Text is a plain roster-action-btn, same class/size as Filter - not .primary-btn.
  assert.doesNotMatch(filterRow, /primary-btn/);
  assert.doesNotMatch(filterRow, /Select All|Select None/);
  // Select All now lives in the table's own first-column header cell.
  assert.match(text, /<th class="no-print"><input type="checkbox" id="email-select-all" aria-label="Select all" \/><\/th>/);
}

test('Main Admin Email tab: Filter/Create Email share one toolbar row, and Select All lives in the table header', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/announcements/email').set('Cookie', cookie);
  assert.equal(res.status, 200);
  checkToolbar(res.text);
  assert.match(res.text, /class="roster-action-btn">Create Email</);
});

test('Main Admin Text tab: same toolbar treatment as Email', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  assert.equal(res.status, 200);
  checkToolbar(res.text);
  assert.match(res.text, /class="roster-action-btn">Create Text</);
});

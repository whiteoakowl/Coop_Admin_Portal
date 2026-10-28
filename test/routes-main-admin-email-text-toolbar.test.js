// A real request: "email tab, add and select all and select none check
// boxes. neatly on the same row. create email and filter button should be
// on the same row, same size, text fit in the button, clean and
// professional. same with text tab." Main Admin's Email/Text tabs had
// moved to a single combined checkbox in the table header, then to a
// Select All/Select None checkbox pair in their own toolbar row, then to
// just Select All after "remove select none option," then to a single
// header-cell checkbox after "remove select all and select none buttons."
//
// A later real request combined Email and Text into one Text/Email page
// with "three buttons at the top. Filter, send text, send email" -
// Filter is no longer a dialog trigger that shares a row with a
// Create-Email/Text button; it is its own button on the combined landing
// page, next to Send Text/Send Email, all three the same
// .roster-action-btn class/size this earlier request asked for. Select
// All still lives in the Filter page's own table header cell (see
// test/routes-communication-email.test.js/routes-communication-
// text.test.js for the full select-all-checkbox behavior).
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

test('Main Admin Text/Email page: Filter/Send Text/Send Email share one toolbar row, same class/size', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/announcements/text-email').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const rows = [...res.text.matchAll(/<div class="roster-btn-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(rows.length, 1, 'expected a single toolbar row for Filter/Send Text/Send Email');
  const row = rows[0];
  assert.match(row, /class="roster-action-btn" href="\/main-admin\/announcements\/text-email\/filter">Filter</);
  assert.match(row, /class="roster-action-btn" href="\/main-admin\/announcements\/text-email\/send-text">Send Text</);
  assert.match(row, /class="roster-action-btn" href="\/main-admin\/announcements\/text-email\/send-email">Send Email</);
});

test('Main Admin Text/Email Filter page: Select All lives in the candidate table header, and Save Filter is the only submit button', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/announcements/text-email/filter').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<th class="no-print"><input type="checkbox" id="email-select-all" aria-label="Select all" \/><\/th>/);
  assert.match(res.text, /class="primary-btn">Save Filter</);
  assert.doesNotMatch(res.text, /Select All|Select None/);
});

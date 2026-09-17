// A real request: "email tab, add and select all and select none check
// boxes. neatly on the same row. create email and filter button should be
// on the same row, same size, text fit in the button, clean and
// professional. same with text tab." Main Admin's Email/Text tabs had
// moved to a single combined checkbox in the table header (a real earlier
// request: "select all or none should be checkboxes not buttons") and the
// Create Email/Create Text button used .primary-btn (a different size/
// margin than Filter's own .roster-action-btn) - both now sit in the same
// .email-toolbar-row as two plain Select All/Select None checkboxes
// (checkbox-option, matching every bulk print picker's own pattern under
// Design/Print) plus Filter and Create Email/Text, all .roster-action-btn.
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
  const rowMatch = /<div class="roster-btn-row email-toolbar-row">([\s\S]*?)<\/div>/.exec(text);
  assert.ok(rowMatch, 'expected the email-toolbar-row');
  const row = rowMatch[1];
  assert.match(row, /<label class="checkbox-option email-select-all"><input type="checkbox" id="email-select-all" \/> Select All<\/label>/);
  assert.match(row, /<label class="checkbox-option email-select-none"><input type="checkbox" id="email-select-none" \/> Select None<\/label>/);
  assert.match(row, /class="roster-action-btn" onclick="document\.getElementById\('email-filter-dialog'\)\.showModal\(\)">Filter</);
  // Create Email/Text is a plain roster-action-btn now, same class/size as Filter - not .primary-btn.
  assert.doesNotMatch(row, /primary-btn/);
  // No more combined select-all/none checkbox living in the table's own header cell.
  assert.doesNotMatch(text, /<th><input type="checkbox" id="email-select-all"/);
}

test('Main Admin Email tab: Select All/Select None checkboxes and Filter/Create Email buttons share one toolbar row, same button class', async () => {
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

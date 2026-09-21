// Coverage for a real request: "main admin, edit button, actions drop
// down should also have delete. also add select none and check box next
// to select all." The Members tab's Edit-mode "Actions" dropdown
// (views/main-admin-members.ejs) used to only offer Archive (Delete was
// deliberately dropped by an earlier request, then asked back by this
// one); Select All also had no "Select None" companion checkbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-edit-mode-actions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-edit-mode-actions-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Members tab Edit mode: Actions dropdown has Delete alongside Archive, and a Select None checkbox sits next to Select All', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const controlsMatch = /<div class="class-schedule-archive-controls" data-archive-controls="members-select-form" hidden>([\s\S]*?)<\/div>\s*<\/div>/.exec(res.text);
  assert.ok(controlsMatch, 'expected the Edit-mode controls block');
  const controls = controlsMatch[1];

  assert.match(controls, /data-select-all-for="members-select-form"/);
  assert.match(controls, /data-select-none-for="members-select-form"/);
  assert.match(controls, /Select None/);

  assert.match(controls, /value="archive"[\s\S]*?data-bulk-action="\/main-admin\/members\/bulk-archive"/);
  assert.match(controls, /value="delete"[\s\S]*?data-bulk-action="\/main-admin\/members\/bulk-delete"/);
});

test('the Actions dropdown Delete option actually deletes the selected member(s)', async () => {
  const cookie = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Dropdown Delete Test', 'ddt-1', 'student', 1) RETURNING id").get()).id;
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  await request(app).post('/main-admin/members/bulk-delete').set('Cookie', cookie).type('form').send({ memberIds: String(memberId), _csrf: csrf });

  const row = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  assert.equal(row, undefined, 'the member should be gone after bulk-delete');
});

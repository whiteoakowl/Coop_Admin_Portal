// A real request: "Co-op admin. Members, export, print and edit buttons
// should be similar size and on the same row. For mobile." This toolbar
// previously opted into a fixed 2-column mobile grid (data-fixed-
// columns="2", from an earlier request to keep 3 buttons off one wide
// row) - roster-btn-row-grid.js's own adaptive layout already puts N<=4
// buttons in a single, evenly-sized row when no data-fixed-columns
// override is present, so removing the override is the fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-toolbar-mobile-row-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-toolbar-mobile-row-test-uploads-${process.pid}`);
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

// A later real request removed the "Edit" toggle entirely (checkboxes
// are permanently visible now - see test/routes-admin-members-bulk-
// actions.test.js) and changed Export/Print to icon-only buttons
// ("change export and print buttons to icons").
test('Members page toolbar: Export/Print have no fixed-columns override, so the adaptive mobile layout lays them out on one row', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);
  const toolbarSection = /id="members-toolbar">([\s\S]*?)<div class="class-schedule-archive-controls"/.exec(page.text);
  assert.ok(toolbarSection, 'expected to find the Members toolbar section');
  const rowOpenTag = /<div class="roster-btn-row"([^>]*)>/.exec(toolbarSection[1]);
  assert.ok(rowOpenTag, "expected to find the toolbar's .roster-btn-row opening tag");
  assert.doesNotMatch(rowOpenTag[1], /data-fixed-columns/, 'no fixed-columns override should remain, so the adaptive JS lays out the buttons on one row');
  assert.match(page.text, /aria-label="Export CSV"/);
  assert.match(page.text, /aria-label="Print"/);
  assert.doesNotMatch(page.text, />Edit</, 'the old Edit toggle button is gone');
});

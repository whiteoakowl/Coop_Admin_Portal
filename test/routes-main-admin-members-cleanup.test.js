// A real request: "main admin, members, no description. When you click
// edit permissions you should then only see one button for save
// permissions. Once you click save you see all the original buttons
// again. Approvals tab, no description. Delete descriptions under member
// settings as well. No description under archive members."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-cleanup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-cleanup-test-uploads-${process.pid}`);
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

test('no description text on Members, Archive, Approvals, or Settings tabs', async () => {
  const cookie = await loginAsMainAdmin();

  const membersPage = await request(app).get('/main-admin/members?tab=members').set('Cookie', cookie);
  assert.doesNotMatch(membersPage.text, /The full family\/member roster/);

  const archivePage = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.doesNotMatch(archivePage.text, /The full family\/member roster/);

  const approvalsPage = await request(app).get('/main-admin/members?tab=approvals').set('Cookie', cookie);
  assert.doesNotMatch(approvalsPage.text, /Self-registered members awaiting review/);

  const settingsPage = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.doesNotMatch(settingsPage.text, /Use <code>\{\{name\}\}<\/code>/);
  assert.doesNotMatch(settingsPage.text, /an applicant must scroll through this/);
  assert.doesNotMatch(settingsPage.text, /Leave the fee at \$0 to hide the fee amount/);
  assert.doesNotMatch(settingsPage.text, /Extra questions shown on the Parent\/Guardian and Student sections/);
});

test('the Members toolbar carries a single .roster-btn-row with the Edit Permissions and Save Permissions buttons as siblings', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members?tab=members').set('Cookie', cookie);
  const rowMatch = /<div class="roster-btn-row roster-btn-row-fit-text no-print">([\s\S]*?)<\/div>\s*<dialog/.exec(res.text);
  assert.ok(rowMatch, 'expected the members toolbar row');
  const rowHtml = rowMatch[1];
  assert.match(rowHtml, /data-permissions-toggle="members-table"/);
  assert.match(rowHtml, /data-permissions-save="members-table" hidden/, 'Save Permissions starts hidden - JS reveals it and hides everything else when Edit Permissions is clicked');
  assert.match(rowHtml, /\+ Add Member/);
  assert.match(rowHtml, />Import</);
  assert.match(rowHtml, />Export</);
  // A later real request: "delete create account button. every member
  // already automatically has an account. instead there can be an add
  // member button" - + Add Member (already present above) replaces it.
  assert.doesNotMatch(rowHtml, />Create Accounts</);
  assert.match(rowHtml, />Add\/Edit Sections</);
});

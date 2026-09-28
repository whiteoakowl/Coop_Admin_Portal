// A real request: "Co-op admin portal, schedules, member schedules,
// remove the member name dropdown menu. The filter button does the
// search now." The Member Schedules toolbar used to have its own always-
// visible "<Type> Name" dropdown sitting next to (not inside) the Filter
// button, each option instantly navigating on change. It's now just
// another field inside the existing schedule-filter-dialog popup,
// submitted together with Type/Family Name - see views/admin-schedule.ejs's
// own comment on this.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-name-filter-dialog-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-name-filter-dialog-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('the Member Schedules toolbar no longer has its own standalone name dropdown', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/schedule?tab=members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const toolbarMatch = /<div class="roster-toolbar no-print">[\s\S]*?<\/div>\s*<\/div>/.exec(res.text);
  assert.ok(toolbarMatch, 'expected to find the toolbar');
  assert.doesNotMatch(toolbarMatch[0], /schedule-name-select/, 'the toolbar itself should not carry the old always-visible name dropdown');
});

test('the name select now lives inside the Filter dialog, alongside Type and Family', async () => {
  const cookie = await loginAsAdmin();
  const member = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Dialog Filter Member', 'dialog-filter-member-1', 'parent', 1)").run()).lastInsertRowid;

  const res = await request(app).get('/admin/schedule?tab=members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const dialogMatch = /<dialog id="schedule-filter-dialog"[\s\S]*?<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'expected to find the Filter dialog');
  const dialogHtml = dialogMatch[0];
  assert.match(dialogHtml, /<select id="schedule-name-select" name="memberId">/, 'the name select should now be inside the Filter dialog, submitted as memberId');
  assert.match(dialogHtml, new RegExp(`<option value="${member}"[^>]*>Dialog Filter Member</option>`));
});

test('picking a member from the dialog and applying the filter still narrows the list down to just them, same as the old dropdown did', async () => {
  const cookie = await loginAsAdmin();
  const kept = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Kept Schedule Member', 'kept-schedule-member-1', 'parent', 1)").run()).lastInsertRowid;
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Excluded Schedule Member', 'excluded-schedule-member-1', 'parent', 1)").run();

  const res = await request(app).get(`/admin/schedule?tab=members&type=parent&memberId=${kept}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Kept Schedule Member/);

  // "Excluded Schedule Member" still legitimately appears once, as one of
  // the OTHER options inside the (now-relocated) name <select> itself -
  // this only checks that the actual card grid was narrowed down, same as
  // the old standalone dropdown already did.
  const gridMatch = /<div class="schedule-card-grid">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(res.text);
  assert.ok(gridMatch, 'expected to find the schedule card grid');
  assert.doesNotMatch(gridMatch[0], /Excluded Schedule Member/, 'only the picked member\'s own card should remain in the grid');

  // The Filter button's own label should reflect the picked name, same as
  // it already does for Type/Family - the dropdown's own selection is no
  // longer visible anywhere else once it moves inside the dialog.
  const filterBtnMatch = /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('schedule-filter-dialog'\)\.showModal\(\)">[\s\S]*?<\/button>/.exec(res.text);
  assert.ok(filterBtnMatch);
  assert.match(filterBtnMatch[0], /Kept Schedule Member/, 'the Filter button label should show the selected member, replacing what the old dropdown used to surface');
});

// A real request: "main admin portal, member page button order on
// mobile. Add member, edit member list, add/edit family. 2nd row
// underneath, edit permissions, add/edit sections. 3rd row underneath
// filter, import, export, print." A later real request removed the
// "Edit Member List" toggle entirely (see test/routes-main-admin-
// members-edit-mode-actions.test.js), so row 1 is just Add Member,
// Add/Edit Family now. A further real request removed Edit Permissions
// and Add/Edit Sections from this toolbar too (see test/routes-main-
// admin-members-cleanup.test.js) - row 2 is just Grade Level Report now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-mobile-button-order-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-mobile-button-order-test-uploads-${process.pid}`);
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

test('Members tab toolbar: buttons/filter appear in the exact requested 3/2/4 row order, with a mobile-only break between each group', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  const toolbarMatch = /<div class="roster-btn-row roster-btn-row-fit-text no-print">([\s\S]*?)<\/div>\s*<dialog/.exec(page.text);
  assert.ok(toolbarMatch, 'expected the Members tab button toolbar');
  const toolbar = toolbarMatch[1];

  // Row 1: Add Member, Add/Edit Family (Edit Member List removed).
  const addMemberIdx = toolbar.indexOf('+ Add Member');
  const addFamilyIdx = toolbar.indexOf('Add/Edit Family');
  const break1Idx = toolbar.indexOf('roster-btn-row-break');
  // Row 2: Grade Level Report (Edit Permissions/Add/Edit Sections removed).
  const gradeLevelReportIdx = toolbar.indexOf('Grade Level Report');
  const break2Idx = toolbar.indexOf('roster-btn-row-break', break1Idx + 1);
  // Row 3: Filter, Import, Export, Print. Filter is a button+popup now
  // (a real request: "filter dropdown should change to an orange button
  // with a popup"), not a <select>. Import/Export/Print are all icon-
  // only buttons now ("change export and print buttons to icons" / "all
  // pages/subpages with print, export, import, or download buttons
  // should be changed to icons") - located by their aria-label instead
  // of visible text.
  const filterIdx = toolbar.indexOf("document.getElementById('members-filter-dialog')");
  const importIdx = toolbar.indexOf('aria-label="Import"');
  const exportIdx = toolbar.indexOf('aria-label="Export CSV"');
  const printIdx = toolbar.indexOf('aria-label="Print"');

  assert.ok(addMemberIdx < addFamilyIdx && addFamilyIdx < break1Idx, 'row 1 order: Add Member, Add/Edit Family, then a break');
  assert.ok(break1Idx < gradeLevelReportIdx && gradeLevelReportIdx < break2Idx, 'row 2: Grade Level Report, then a break');
  assert.ok(break2Idx < filterIdx && filterIdx < importIdx && importIdx < exportIdx && exportIdx < printIdx, 'row 3 order: Filter, Import, Export, Print');
  assert.doesNotMatch(toolbar, /Edit Permissions|Add\/Edit Sections/);
});

test('Archive tab still has its own Filter dropdown, with no button toolbar to join', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /roster-btn-row-fit-text/, 'the Archive tab has no button toolbar');
  // Filter now leads the row (a real request: "filter button should be
  // first on the row"), so the capture must run past the filter's own
  // dialog to the search form's closing tag, not stop at the first
  // </dialog> (which now belongs to the filter, not the row).
  const rowMatch = /<div class="members-search-filter-row no-print">([\s\S]*?<\/form>)\s*<\/div>/.exec(page.text);
  assert.ok(rowMatch, 'expected the search+filter row');
  assert.match(rowMatch[1], /class="members-search-bar"/);
  assert.match(rowMatch[1], /onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)"/);
});

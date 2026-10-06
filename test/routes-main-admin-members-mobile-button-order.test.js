// A real request: "main admin portal, member page button order on
// mobile. Add member, edit member list, add/edit family. 2nd row
// underneath, edit permissions, add/edit sections. 3rd row underneath
// filter, import, export, print."
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

  // Row 1: Add Member, Edit Member List, Add/Edit Family.
  const addMemberIdx = toolbar.indexOf('+ Add Member');
  const editListIdx = toolbar.indexOf('Edit Member List');
  const addFamilyIdx = toolbar.indexOf('Add/Edit Family');
  const break1Idx = toolbar.indexOf('roster-btn-row-break');
  // Row 2: Edit Permissions, Add/Edit Sections.
  const editPermissionsIdx = toolbar.indexOf('Edit Permissions');
  const addSectionsIdx = toolbar.indexOf('Add/Edit Sections');
  const break2Idx = toolbar.indexOf('roster-btn-row-break', break1Idx + 1);
  // Row 3: Filter, Import, Export, Print. Filter is a button+popup now
  // (a real request: "filter dropdown should change to an orange button
  // with a popup"), not a <select>.
  const filterIdx = toolbar.indexOf("document.getElementById('members-filter-dialog')");
  const importIdx = toolbar.indexOf('>Import<');
  const exportIdx = toolbar.indexOf('>Export<');
  const printIdx = toolbar.indexOf('>Print<');

  assert.ok(addMemberIdx < editListIdx && editListIdx < addFamilyIdx && addFamilyIdx < break1Idx, 'row 1 order: Add Member, Edit Member List, Add/Edit Family, then a break');
  assert.ok(break1Idx < editPermissionsIdx && editPermissionsIdx < addSectionsIdx && addSectionsIdx < break2Idx, 'row 2 order: Edit Permissions, Add/Edit Sections, then a break');
  assert.ok(break2Idx < filterIdx && filterIdx < importIdx && importIdx < exportIdx && exportIdx < printIdx, 'row 3 order: Filter, Import, Export, Print');
});

test('Archive tab still has its own Filter dropdown, with no button toolbar to join', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /roster-btn-row-fit-text/, 'the Archive tab has no button toolbar');
  const rowMatch = /<div class="members-search-filter-row no-print">([\s\S]*?)<\/dialog>/.exec(page.text);
  assert.ok(rowMatch, 'expected the search+filter row');
  assert.match(rowMatch[1], /class="members-search-bar"/);
  assert.match(rowMatch[1], /onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)"/);
});

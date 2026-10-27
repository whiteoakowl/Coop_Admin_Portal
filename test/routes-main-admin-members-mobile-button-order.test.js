// A real request: "main admin portal, member page button order on
// mobile. Add member, edit member list, add/edit family. 2nd row
// underneath, edit permissions, add/edit sections. 3rd row underneath
// filter, import, export, print." A later real request removed the
// "Edit Member List" toggle entirely (see test/routes-main-admin-
// members-edit-mode-actions.test.js), so row 1 is just Add Member,
// Add/Edit Family now. A further real request removed Edit Permissions
// and Add/Edit Sections from this toolbar too (see test/routes-main-
// admin-members-cleanup.test.js) - row 2 is just Grade Level Report now.
// Several later real requests reshuffled things further: Grade Level
// Report moved next to Add/Edit Family (row 1), Filter moved onto the
// same row as the search bar (row 2), and Import/Export/Print/PDF moved
// onto the same row as Select All/Bulk Edit (row 3). A final request,
// "Put bulk edit button next to filter button and shrink the search
// bar," moved Bulk Edit again, out of row 3 and onto row 2 next to
// Filter - see this file's own inline comments below for each.
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

test('Members tab toolbar: buttons/filter/icons appear in the exact requested order across 3 rows, with no mobile-only break left anywhere', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  // Plain index order on the full page, not a regex slicing out one
  // row's own substring - members-type-filter.ejs's own <dialog> (nested
  // <div>s and all) sits inline right after its trigger button, which
  // breaks any regex trying to capture "up to the next </div>" or "up to
  // the next <dialog>" (see git history on this file for the exact bug).
  const text = page.text;
  // Row 1: + Add Member, Add/Edit Family, Grade Level Report. A real
  // request: "Grade level report button should be next to add/edit
  // family button" - no break between them any more, so all three just
  // wrap onto the same flex row together.
  const addMemberIdx = text.indexOf('+ Add Member');
  const addFamilyIdx = text.indexOf('Add/Edit Family');
  const gradeLevelReportIdx = text.indexOf('Grade Level Report');
  // Row 2: Filter, Bulk Edit, then the search bar - a real request:
  // "Filter button and search bar should be on the same row" moved
  // Filter out of its own row and into .members-search-filter-row (same
  // spot the Archive tab's own copy already used). A later real request,
  // "Put bulk edit button next to filter button and shrink the search
  // bar," moved Bulk Edit out of row 3 into this same row, between
  // Filter and the search bar.
  const filterIdx = text.indexOf("document.getElementById('members-filter-dialog')");
  const bulkEditIdx = text.indexOf('id="bulk-edit-btn"');
  const searchBarIdx = text.indexOf('class="members-search-bar"');
  // Row 3: Select All, then Import/Export/Print/PDF - a real request:
  // "Import, export, pdf and print icons next to bulk edit button on the
  // same row" (Bulk Edit has since moved to row 2, but the icons stayed
  // on this row with Select All). Import/Export/Print are icon-only
  // buttons ("change export and print buttons to icons" / "all
  // pages/subpages with print, export, import, or download buttons
  // should be changed to icons") - located by their aria-label instead
  // of visible text.
  const selectAllIdx = text.indexOf('data-select-all-for="members-select-form"');
  const importIdx = text.indexOf('aria-label="Import"');
  const exportIdx = text.indexOf('aria-label="Export CSV"');
  const printIdx = text.indexOf('aria-label="Print"');
  const pdfIdx = text.indexOf('aria-label="Download PDF"');

  assert.ok(addMemberIdx < addFamilyIdx && addFamilyIdx < gradeLevelReportIdx, 'row 1 order: Add Member, Add/Edit Family, Grade Level Report');
  assert.ok(gradeLevelReportIdx < filterIdx, 'row 1 (Grade Level Report) comes before row 2 (Filter)');
  assert.ok(filterIdx < bulkEditIdx && bulkEditIdx < searchBarIdx, 'row 2 order: Filter, Bulk Edit, then the search bar');
  assert.ok(searchBarIdx < selectAllIdx, 'row 2 (search bar) comes before row 3 (Select All)');
  assert.ok(
    selectAllIdx < importIdx && importIdx < exportIdx && exportIdx < printIdx && printIdx < pdfIdx,
    'row 3 order: Select All, Import, Export, Print, Download PDF'
  );
  // No .roster-btn-row-break spacers left anywhere on this page - the one
  // that used to separate Add/Edit Family from Grade Level Report is gone
  // along with the one that used to precede Filter.
  assert.doesNotMatch(text, /roster-btn-row-break/, 'expected no mobile-only row break left on this page');
  assert.doesNotMatch(text, /Edit Permissions|Add\/Edit Sections/);
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

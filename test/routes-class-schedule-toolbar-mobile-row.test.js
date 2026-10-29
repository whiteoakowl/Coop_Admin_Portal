// A real request: "Co-op admin portal. Class schedules. Mobile. Add
// class button, edit schedule grid button, on same row. Bulk edit
// classes filter, select all, list vs grid view all pn the same row,
// button should all be on the same row, side by side. Underneath that
// row should be all of the import, export, pdf and print icons, side by
// side." Checks views/partials/class-schedule-grid.ejs's own toolbar is
// now three rows: (1) Add Class + Edit Schedule Grids, (2) Bulk
// Edit/Filter/Select All/Grid-List toggle, (3) Import/Export/PDF/Print
// icons - instead of the old shape where Add Class/Edit Schedule Grids/
// Import/Bulk Edit were all crammed into the same row as Export/Print/PDF.
//
// Each element below has a unique "-monday" (or "monday" query param)
// marker, so plain indexOf ordering on the whole rendered page is
// reliable - no need to first carve out "just the toolbar" with a
// brittle regex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-toolbar-mobile-row-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-toolbar-mobile-row-test-uploads-${process.pid}`);
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

test('Class Schedules toolbar: Add Class and Edit Schedule Grids share their own row, directly inside the toolbar (not the filter-row or the icon row)', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.equal(page.status, 200);

  const rowMatch = /<div class="roster-btn-row">\s*<button type="button" class="roster-action-btn" onclick="document\.getElementById\('add-class-dialog-monday'\)\.showModal\(\)">\+ Add Class<\/button>\s*<button type="button" class="roster-action-btn" onclick="document\.getElementById\('edit-schedule-dialog-monday'\)\.showModal\(\)">Edit Schedule Grids<\/button>\s*<\/div>/.exec(page.text);
  assert.ok(rowMatch, 'expected + Add Class and Edit Schedule Grids to be the only two buttons in their own roster-btn-row, side by side');
});

test('Class Schedules toolbar: Bulk Edit, Filter, Select All, and the Grid/List view toggle all share the filter-row, in that order', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);

  const filterRowStart = page.text.indexOf('<div class="filter-row">');
  assert.ok(filterRowStart !== -1, 'expected to find the filter-row');
  const bulkEditIdx = page.text.indexOf('data-bulk-edit-toggle="class-bulk-edit-form-monday"', filterRowStart);
  const filterIdx = page.text.indexOf('>Filter</summary>', filterRowStart);
  const selectAllIdx = page.text.indexOf('data-select-all-for="class-bulk-edit-form-monday"', filterRowStart);
  const viewToggleIdx = page.text.indexOf('class="class-schedule-view-toggle"', filterRowStart);

  assert.ok(bulkEditIdx !== -1 && bulkEditIdx < viewToggleIdx, 'expected Bulk Edit button inside the filter-row');
  assert.ok(filterIdx !== -1 && filterIdx < viewToggleIdx, 'expected Filter trigger inside the filter-row');
  assert.ok(selectAllIdx !== -1 && selectAllIdx < viewToggleIdx, 'expected Select All checkbox inside the filter-row');
  assert.ok(viewToggleIdx !== -1, 'expected the Grid/List view toggle inside the filter-row');
  // "Bulk edit classes filter, select all, list vs grid view" - that order.
  assert.ok(bulkEditIdx < filterIdx, 'expected Bulk Edit before Filter');
  assert.ok(filterIdx < selectAllIdx, 'expected Filter before Select All');
  assert.ok(selectAllIdx < viewToggleIdx, 'expected Select All before the Grid/List toggle');
});

test('Class Schedules toolbar: Import/Export/PDF/Print icons sit together in their own row underneath, in that order, with no fixed-columns override (adaptive one-row layout)', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);

  const importIdx = page.text.indexOf("document.getElementById('import-dialog-monday').showModal()");
  assert.ok(importIdx !== -1, 'expected an Import icon button');
  const rowStart = page.text.lastIndexOf('<div class="roster-btn-row">', importIdx);
  assert.ok(rowStart !== -1, 'expected the Import icon to sit inside its own roster-btn-row');
  const rowEnd = page.text.indexOf('</div>', page.text.indexOf('download.pdf', importIdx));
  const row = page.text.slice(rowStart, rowEnd);

  assert.doesNotMatch(row, /data-fixed-columns/, 'no fixed-columns override - roster-btn-row-grid.js lays 4 icons out on one row on its own');
  assert.doesNotMatch(row, />\+ Add Class</, 'Add Class should not be in this icon row any more');
  assert.doesNotMatch(row, />Bulk Edit</, 'Bulk Edit should not be in this icon row any more');

  const exportIdx = row.indexOf('aria-label="Export CSV"');
  const pdfIdx = row.indexOf('aria-label="Download PDF"');
  const printIdx = row.indexOf('aria-label="Print"');
  assert.ok(exportIdx !== -1 && pdfIdx !== -1 && printIdx !== -1, 'expected Export, Download PDF, and Print icons all in this same row as Import');
  // "import, export, pdf and print icons" - that order.
  assert.ok(exportIdx < pdfIdx, 'expected Export before PDF');
  assert.ok(pdfIdx < printIdx, 'expected PDF before Print');
});

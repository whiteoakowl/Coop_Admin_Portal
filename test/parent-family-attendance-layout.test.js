// A real request: "Parent portal, family attendance. Present and absent
// keys should be to the left, not centered and just under the title.
// The description goes under the key bubbles. Then the orange buttons."
// Later requests reordered and reshaped this toolbar several times,
// most recently: "Family attendance should have a filter button to
// choose student, family and school year. When viewing student or
// family it should show all 12 calendar months for that school year.
// Get rid of the month dropdown, name dropdown, everything on one row,
// shrink to fit." - the old separate month-nav row (prev/next arrows,
// Month/Year selects) and single-month table are both gone; the page
// now shows a clickable 12-month grid for the selected school year,
// with Choose Student/Family and School Year both inside one Filter
// popover on the same row as the Export/Print/PDF icons and the
// Present/Absent legend.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-family-attendance-layout-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-family-attendance-layout-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `attlayout${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

test('the description, Filter/icons/legend row, and 12-month grid render in order, with no month nav left behind', async () => {
  const familyId = await createFamily('Attendance Layout Family');
  const parent = await createPortalMember({ name: 'Layout Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Layout Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&schoolYear=2026-2027`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);

  const descriptionIdx = res.text.indexOf('Click a date to mark present');
  const toolbarRowIdx = res.text.indexOf('fs-attendance-toolbar-row');
  const legendIdx = res.text.indexOf('fs-attendance-legend-present');
  const exportIdx = res.text.indexOf('aria-label="Export CSV"');
  const gridIdx = res.text.indexOf('annual-calendar-months-grid');

  assert.ok(descriptionIdx > -1 && toolbarRowIdx > -1 && legendIdx > -1 && exportIdx > -1 && gridIdx > -1, 'every section should be present');
  assert.ok(descriptionIdx < toolbarRowIdx, 'the description should come before the Filter/icons/legend row');
  assert.ok(toolbarRowIdx < exportIdx && toolbarRowIdx < legendIdx, 'the Filter, icons, and legend all live inside the same merged row');
  assert.ok(exportIdx < gridIdx && legendIdx < gridIdx, 'the merged row comes right before the 12-month grid itself');

  // A real request: "Get rid of the month dropdown, name dropdown,
  // everything on one row, shrink to fit." - no month-nav row, no
  // separate Month/Year selects, and no old single-month table left
  // over from before this redesign.
  assert.doesNotMatch(res.text, /fs-attendance-nav-row/);
  assert.doesNotMatch(res.text, /name="month" aria-label="Month"/);
  assert.doesNotMatch(res.text, /aria-label="Previous month"/);
  assert.doesNotMatch(res.text, /aria-label="Next month"/);

  assert.match(res.text, /class="roster-btn-row roster-btn-row-fit-text fs-attendance-row-left fs-attendance-toolbar-row no-print"/);

  // A real request: "Family attendance should have a filter button to
  // choose student, family and school year." Both Choose Student
  // (with its own "Whole Family" option) and School Year now live
  // inside one Filter <details> popover, same convention every other
  // Family School Management page's own Filter button uses.
  assert.match(res.text, /<details class="filter-details" data-filter-details>/);
  assert.match(res.text, /<select id="attendance-student-select" name="studentId" onchange="this\.form\.submit\(\)">\s*<option value="" disabled>Choose Student<\/option>/);
  assert.match(res.text, new RegExp(`<option value="${student.memberId}" selected>Layout Student</`));
  assert.match(res.text, /<option value="family"[^>]*>Whole Family<\/option>/);
  assert.match(res.text, /<select id="attendance-school-year-select" name="schoolYear" onchange="this\.form\.submit\(\)">/);
  assert.match(res.text, /<option value="2026-2027" selected>2026-2027<\/option>/);

  // "When viewing student or family it should show all 12 calendar
  // months for that school year." Aug 2026 - Jul 2027.
  assert.equal((res.text.match(/class="annual-calendar-month"/g) || []).length, 12, 'exactly 12 month grids');
  assert.match(res.text, /<h3>August 2026<\/h3>/);
  assert.match(res.text, /<h3>July 2027<\/h3>/);
  assert.doesNotMatch(res.text, /<h3>August 2025<\/h3>/);

  // The Present/Absent legend lives at the far right of the merged row
  // (margin-left: auto on its own wrapper).
  assert.match(res.text, /<span class="fs-attendance-legend-row">\s*<span class="badge-pill fs-attendance-legend-present">Present<\/span>\s*<span class="badge-pill fs-attendance-legend-absent">Absent<\/span>\s*<\/span>/);

  // A real request, later corrected to a PDF icon: "all down[load]
  // icons across the app should be a puff [cloud] icon... it looks the
  // same as export" / "Should be a pdf. Pdf icon." - Export keeps
  // icon-download, Download gets its own distinct icon-pdf.
  assert.match(res.text, /aria-label="Export CSV"[^>]*><svg class="icon"><use href="#icon-download"\/>/);
  assert.match(res.text, /aria-label="Download PDF"[^>]*><svg class="icon"><use href="#icon-pdf"\/>/);

  // filter-details-dismiss.js closes the Filter popover on an outside
  // click, same as every other Family School Management page's own.
  assert.match(res.text, /filter-details-dismiss\.js/);
});

test('the School Year dropdown always includes the currently selected year, even an old one outside the default window', async () => {
  const familyId = await createFamily('Old Year Family');
  const parent = await createPortalMember({ name: 'Old Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Old Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&schoolYear=2015-2016`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="2015-2016" selected>2015-2016<\/option>/);
});

test('Whole Family mode shows the 12-month grid built from every family student, defaulting to the current school year with no schoolYear param', async () => {
  const familyId = await createFamily('Family Mode Grid Family');
  const parent = await createPortalMember({ name: 'Family Grid Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  await createPortalMember({ name: 'Family Grid Student', familyId, memberType: 'student', roleKey: 'student' });

  const res = await request(app).get('/parent/family-school/attendance?studentId=family').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="family" selected>Whole Family<\/option>/);
  assert.equal((res.text.match(/class="annual-calendar-month"/g) || []).length, 12, 'exactly 12 month grids even in Whole Family mode');
  assert.match(res.text, /data-fs-attendance-calendar data-student-id="family" data-toggle-url="\/parent\/family-school\/attendance\/family\/toggle"/);
});

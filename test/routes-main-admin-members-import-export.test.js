// Coverage for the Main Admin Members page's new Import/Export feature -
// a real request: "add member button, edit permissions button, edit,
// import, export buttons should be under the member tab above filter."
// Shares utils/memberImport.js with routes/admin-members.js's own
// identical feature (test/routes-admin-members-import.test.js covers
// that shared logic in depth) - this file only checks the Main Admin
// wiring itself: the routes exist, are reachable, and the toolbar/card
// markup reflects the rest of that same request (filter renamed to just
// "Filter", buttons above the filter, a role badge and Sections both
// showing on every member's own card).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-import-export-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-import-export-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const XLSX = require('xlsx');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

// Same buffer-a-binary-response shape as test/parent-family-school-print-
// preview-and-pdf.test.js's own getBuffer - supertest's default text
// parser corrupts a real PDF's binary body.
async function getBuffer(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

// A later real request removed "Edit Permissions" from this toolbar
// entirely (see test/routes-main-admin-members-cleanup.test.js).
test('Members page toolbar: Add Member/Import/Export sit above a "Filter" (not "type or family") control', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  const buttonRowIndex = page.text.indexOf('+ Add Member');
  const filterIndex = page.text.indexOf('members-filter-dialog');
  assert.ok(buttonRowIndex > -1 && filterIndex > -1 && buttonRowIndex < filterIndex, 'the button row must come before the filter control');

  // A real request: "change export and print buttons to icons" / "all
  // pages/subpages with print, export, import, or download buttons
  // should be changed to icons" - Import/Export are icon-only now
  // (aria-label, no visible text).
  assert.match(page.text, /aria-label="Import"/);
  assert.match(page.text, /aria-label="Export CSV"/);
  // A real request: "filter dropdown should change to an orange button
  // with a popup" - same Filter-button-opens-a-dialog shape as the
  // Member Schedules page's own Filter.
  assert.match(page.text, /onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)"/);
  assert.match(page.text, /<h3>Filter Members<\/h3>/);
  assert.doesNotMatch(page.text, /Filter by type or family/);
});

// Coverage for a real request: "add a print button to member list. make
// sure the printing is clean and fits nicely on pages with borders."
// A later real request: "all print button should show a print preview
// full real page on a page with a print button" - Print now opens a
// dedicated preview route in a new tab instead of calling window.print()
// on this live, editable page directly.
test('Members page toolbar has a Print button linking to a dedicated preview page, and a branded print-only header', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /<a class="icon-btn" href="\/main-admin\/members\/print"[^>]*target="_blank"[^>]*aria-label="Print"/);
  assert.doesNotMatch(page.text, /onclick="window\.print\(\)"[^>]*aria-label="Print"/);
  assert.match(page.text, /<div class="print-header">[\s\S]*?<p class="print-header-sub">Members<\/p>/);
  // A real request: "the download should be a pdf of exactly how it
  // would also look when printing" - Download PDF sits right beside Print.
  assert.match(page.text, /<a class="icon-btn" href="\/main-admin\/members\/download\.pdf"[^>]*aria-label="Download PDF"/);
});

test('GET /main-admin/members/print renders a read-only preview with a Print button and the same filtered members', async () => {
  const { cookie } = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('PrintPreviewFamily') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Print Preview Member', 'print-preview-member-1', 'parent', ?, 1)").run(familyId);

  const res = await request(app).get('/main-admin/members/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /print-preview-header/);
  assert.match(res.text, /onclick="window\.print\(\)"/);
  assert.match(res.text, /Print Preview Member/);

  const filteredRes = await request(app).get(`/main-admin/members/print?family=${familyId}`).set('Cookie', cookie);
  assert.equal(filteredRes.status, 200);
  assert.match(filteredRes.text, /Print Preview Member/);
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - a real PDF built from the exact
// same main-admin-members-print.ejs view the Print button opens.
test('GET /main-admin/members/download.pdf returns a real PDF', async () => {
  const { cookie } = await loginAsMainAdmin();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Download PDF Member', 'download-pdf-member-1', 'parent', 1)").run();

  const res = await getBuffer('/main-admin/members/download.pdf', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="members\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
});

test('GET /main-admin/members/export.csv exports the roster as CSV', async () => {
  const { cookie } = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('ExportTestFamily') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Export Test Member', 'export-test-1', 'parent', ?, 1)").run(familyId);

  const res = await request(app).get('/main-admin/members/export.csv').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /csv/);
  assert.match(res.text, /Export Test Member/);
});

// A real bug: utils/memberImport.js's own buildMembersExportCsvLines
// only ever distinguished 'parent' from everything else, so an
// admin-type member (member_type 'admin' - see utils/adminPositions.js's
// syncMemberAdminStatus) exported with "Student" in the Type column
// instead of "Admin".
test('GET /main-admin/members/export.csv labels an admin-type member as Admin, not Student', async () => {
  const { cookie } = await loginAsMainAdmin();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Export Admin Member', 'export-admin-1', 'admin', 1)").run();

  const res = await request(app).get('/main-admin/members/export.csv').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const row = res.text.split('\n').find((line) => line.includes('Export Admin Member'));
  assert.ok(row, 'the exported admin member should appear in the CSV');
  assert.match(row, /,"Admin",/);
  assert.doesNotMatch(row, /,"Student",/);
});

test('GET /main-admin/members/import-template.xlsx downloads the same template shape as Co-op Admin', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members/import-template.xlsx').set('Cookie', cookie).buffer(true).parse((response, callback) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  });
  assert.equal(res.status, 200);
  const wb = XLSX.read(res.body, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  assert.deepEqual(rows[0].slice(0, 2), ['First Name', 'Last Name']);
});

test('POST /main-admin/members/import creates a new member from an uploaded spreadsheet', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const headers = ['First Name', 'Last Name', 'Type'];
  const ws = XLSX.utils.aoa_to_sheet([headers, ['Import', 'Tester', 'Parent']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const res = await request(app)
    .post('/main-admin/members/import?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', buffer, 'import.xlsx');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const created = await db.prepare("SELECT * FROM members WHERE name = 'Import Tester'").get();
  assert.ok(created, 'expected the imported row to create a real member');
  assert.equal(created.member_type, 'parent');
});

test('the member card shows both its role badge and, when assigned, its Sections - on every screen size, not just one', async () => {
  // A real request, with a reference screenshot, replaced the old table
  // (whose Type column swapped for a Sections column only at mobile
  // widths, via a CSS media query) with one card per member - both a
  // role badge (Parent/Student/Admin) and a Sections subline (when any
  // are assigned) now render unconditionally, so there's no swap left to
  // test for.
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.match(page.text, /class="badge-pill badge-pill-\w+ member-role-badge"/);
});

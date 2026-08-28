// Coverage for the Main Admin Members page's new Import/Export feature -
// a real request: "add member button, edit permissions button, edit,
// import, export buttons should be under the member tab above filter."
// Shares utils/memberImport.js with routes/admin-members.js's own
// identical feature (test/routes-admin-members-import.test.js covers
// that shared logic in depth) - this file only checks the Main Admin
// wiring itself: the routes exist, are reachable, and the toolbar/table
// markup reflects the rest of that same request (filter renamed to just
// "Filter", buttons above the filter, Type swapped for Sections on the
// mobile-only column).
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

test('Members page toolbar: Add Member/Edit Permissions/Edit/Import/Export sit above a "Filter" (not "type or family") control', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  const buttonRowIndex = page.text.indexOf('+ Add Member');
  const filterIndex = page.text.indexOf('for="type-select"');
  assert.ok(buttonRowIndex > -1 && filterIndex > -1 && buttonRowIndex < filterIndex, 'the button row must come before the filter control');

  assert.match(page.text, />Edit Permissions</);
  assert.match(page.text, />Edit</);
  assert.match(page.text, />Import</);
  assert.match(page.text, />Export</);
  assert.match(page.text, /<label for="type-select">Filter<\/label>/);
  assert.doesNotMatch(page.text, /Filter by type or family/);
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

test('the mobile-only member row shows Sections (not Type), matching the members-col-sections/members-col-type CSS swap', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.match(page.text, /class="members-col-sections"/);
  assert.match(page.text, /<th class="members-col-type">Type<\/th>/);
});

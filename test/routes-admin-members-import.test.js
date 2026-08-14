// Real HTTP-level coverage for the Members page's full-profile "Import"
// feature (routes/admin-members.js's GET /members/import-template.xlsx +
// POST /members/import) after its Name/Parent Name columns were split into
// separate First/Last Name columns (matching Mass Import Families' own
// split, see test/routes-admin-members-mass-import.test.js) - the columns
// are joined back into the single "First Last" string every member is
// stored as (utils/members.js's lastNameOf), so exact-name matching,
// duplicate detection, and parent-linking all keep working unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-import-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-import-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

const IMPORT_HEADERS = [
  'First Name', 'Last Name', 'Type', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email',
  'Birthday', 'Grade Level', 'Medical/Allergy Notes', 'Parent First Name', 'Parent Last Name',
];

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('GET /admin/members/import-template.xlsx has separate First/Last Name columns for both member and parent', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app)
    .get('/admin/members/import-template.xlsx')
    .set('Cookie', cookie)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  const wb = XLSX.read(res.body, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  assert.deepEqual(rows[0], IMPORT_HEADERS);
});

test('POST /admin/members/import', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('First/Last Name columns are joined into the stored "First Last" name, and Parent First/Last links the student to that parent', async () => {
    const buffer = buildImportBuffer([
      ['Jane', 'Import', 'Parent', '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543', 'jane.import@example.com', '', '', '', '', ''],
      ['Alice', 'Import', 'Student', '', '', '', '', '', '', '2015-04-12', '5th Grade', 'Peanut allergy', 'Jane', 'Import'],
    ]);
    const res = await request(app)
      .post('/admin/members/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'members.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const jane = await db.prepare("SELECT * FROM members WHERE name = 'Jane Import'").get();
    assert.ok(jane, 'first/last name columns should be joined into a single stored name');
    assert.equal(jane.member_type, 'parent');
    assert.equal(jane.email, 'jane.import@example.com');

    const alice = await db.prepare("SELECT * FROM members WHERE name = 'Alice Import'").get();
    assert.ok(alice);
    assert.equal(alice.grade_level, '5th Grade');

    assert.ok(alice.family_id != null, 'Parent First/Last Name should have linked the student to a family');
    assert.equal(alice.family_id, jane.family_id);
  });
});

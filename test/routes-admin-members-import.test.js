// Real HTTP-level coverage for the Members page's full-profile "Import"
// feature (routes/admin-members.js's GET /members/import-template.xlsx +
// POST /members/import) - separate First/Last Name columns are joined back
// into the single "First Last" string every member is stored as (utils/
// members.js's lastNameOf), so exact-name matching, duplicate detection,
// and parent-linking all keep working unchanged.
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

  // A real bug report - "importing birthdays comes in as NaN/NaN/NaN" -
  // traced (in part) to this route's CREATE-new-member branch: a
  // Birthday cell used to go straight into the INSERT with no
  // normalizeBirthdayToISO pass, so a genuine Excel Date cell's own
  // formatted text ("4/12/2015") got stored completely unconverted -
  // later rendering as literal "NaN/NaN/NaN" (formatDateNumeric's
  // parseISO is a plain split('-'), which fails on non-ISO text). Built
  // with a real Date-typed cell (not a plain string), matching what
  // actually typing a birthdate into Excel/Sheets produces.
  await t.test('a brand-new student\'s Birthday cell from a real Excel Date cell is normalized before it\'s stored', async () => {
    const ws = XLSX.utils.aoa_to_sheet(
      [IMPORT_HEADERS, ['Dana', 'Newcomer', 'Student', '', '', '', '', '', '', new Date(2016, 7, 3), '4th Grade', '', '', '']],
      { cellDates: true }
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app).post('/admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'newcomer.xlsx');
    assert.equal(res.status, 302);

    const dana = await db.prepare("SELECT birthday FROM members WHERE name = 'Dana Newcomer'").get();
    assert.ok(dana);
    assert.equal(dana.birthday, '2016-08-03', 'the raw Excel Date cell text should be normalized to ISO, not stored verbatim');
  });

  // Same bug, the merge-into-an-existing-member path: importing a row
  // that matches an existing member with no birthday on file offers it
  // as a mergeable field (mergeableFieldsFor) - confirming that merge
  // used to write the raw, un-normalized cell text the same way the
  // CREATE branch did.
  await t.test('merging a Birthday from a real Excel Date cell into an existing member (via the confirm step) is normalized too', async () => {
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Merge Target', 'merge-target-1', 'student')").run();

    const ws = XLSX.utils.aoa_to_sheet(
      [IMPORT_HEADERS, ['Merge', 'Target', 'Student', '', '', '', '', '', '', new Date(2014, 11, 25), '', '', '', '']],
      { cellDates: true }
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const importRes = await request(app).post('/admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'merge.xlsx');
    assert.equal(importRes.status, 200, 'a mergeable field should render the confirm-merge page, not redirect');
    const memberIdMatch = /name="allMemberIds" value="(\d+)"/.exec(importRes.text);
    assert.ok(memberIdMatch, 'expected a candidate row on the confirm page');
    const payloadMatch = /name="payloads" value="([^"]*)"/.exec(importRes.text);
    assert.ok(payloadMatch, 'expected the candidate\'s update payload');
    const payload = payloadMatch[1].replace(/&#34;/g, '"');
    assert.match(payload, /2014-12-25/, 'the confirm page\'s own payload should already be the normalized ISO value, not raw Excel text');

    const confirmRes = await request(app)
      .post('/admin/members/import/confirm?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: memberIdMatch[1], allMemberIds: memberIdMatch[1], payloads: payload });
    assert.equal(confirmRes.status, 302);

    const merged = await db.prepare("SELECT birthday FROM members WHERE name = 'Merge Target'").get();
    assert.equal(merged.birthday, '2014-12-25');
  });

  // A real request: "Admin roles is only chosen under settings in main
  // admin portal." Co-op Admin's own Import (unlike Main Admin's, which
  // still honors an "Admin" Type cell) falls back to 'student' for a row
  // typed Admin, same fallback an unrecognized type already gets - see
  // utils/memberImport.js's own allowAdminType parameter.
  await t.test('a row typed "Admin" is created as a Student instead, not actually promoted to Admin', async () => {
    const buffer = buildImportBuffer([['NoPromo', 'ImportRow', 'Admin', '', '', '', '', '', '', '', '', '', '', '']]);
    const res = await request(app).post('/admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'admin-type.xlsx');
    assert.equal(res.status, 302);

    const created = await db.prepare("SELECT member_type FROM members WHERE name = 'NoPromo ImportRow'").get();
    assert.ok(created, 'the row should still have created a member');
    assert.equal(created.member_type, 'student', 'an Admin-typed row imported via Co-op Admin must not actually become Admin');
  });
});

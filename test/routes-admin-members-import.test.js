// Real HTTP-level coverage for the full-profile "Import" feature's shared
// logic (utils/memberImport.js) - separate First/Last Name columns are
// joined back into the single "First Last" string every member is stored
// as (utils/members.js's lastNameOf), so exact-name matching, duplicate
// detection, and parent-linking all keep working unchanged.
//
// Import itself is Main Admin-only now - Co-op Admin's own copy of this
// route (GET /members/import-template.xlsx, POST /members/import[/confirm])
// was removed entirely ("membership to the app/website... member creation
// is Main Admin-only now"), while Main Admin's stayed and still shares this
// same utils/memberImport.js logic (see routes/main-admin-members.js), so
// this suite now drives it through there. test/routes-main-admin-members-
// import-export.test.js covers the Main Admin route's own wiring/markup;
// this file is the deep logic coverage (birthday normalization, parent
// linking, admin-type handling) that used to run against Co-op Admin.
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

test('POST /main-admin/members/import', async (t) => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  await t.test('First/Last Name columns are joined into the stored "First Last" name, and Parent First/Last links the student to that parent', async () => {
    const buffer = buildImportBuffer([
      ['Jane', 'Import', 'Parent', '123 Main St', 'Anytown', 'NC', '27330', '555-987-6543', 'jane.import@example.com', '', '', '', '', ''],
      ['Alice', 'Import', 'Student', '', '', '', '', '', '', '2015-04-12', '5th Grade', 'Peanut allergy', 'Jane', 'Import'],
    ]);
    const res = await request(app)
      .post('/main-admin/members/import?_csrf=' + encodeURIComponent(csrfToken))
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

    const res = await request(app).post('/main-admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'newcomer.xlsx');
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

    const importRes = await request(app).post('/main-admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'merge.xlsx');
    assert.equal(importRes.status, 200, 'a mergeable field should render the confirm-merge page, not redirect');
    const memberIdMatch = /name="allMemberIds" value="(\d+)"/.exec(importRes.text);
    assert.ok(memberIdMatch, 'expected a candidate row on the confirm page');
    const payloadMatch = /name="payloads" value="([^"]*)"/.exec(importRes.text);
    assert.ok(payloadMatch, 'expected the candidate\'s update payload');
    const payload = payloadMatch[1].replace(/&#34;/g, '"');
    assert.match(payload, /2014-12-25/, 'the confirm page\'s own payload should already be the normalized ISO value, not raw Excel text');

    const confirmRes = await request(app)
      .post('/main-admin/members/import/confirm?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: memberIdMatch[1], allMemberIds: memberIdMatch[1], payloads: payload });
    assert.equal(confirmRes.status, 302);

    const merged = await db.prepare("SELECT birthday FROM members WHERE name = 'Merge Target'").get();
    assert.equal(merged.birthday, '2014-12-25');
  });

  // A real request: "Admin roles is only chosen under settings in main
  // admin portal" drove Co-op Admin's own (now-removed) Import to fall
  // back an "Admin" Type cell to Student instead of promoting - but Main
  // Admin's own Settings > Admins tab is exactly the place that request
  // meant, so Main Admin's Import still honors an Admin Type cell as-is
  // (utils/memberImport.js's allowAdminType defaults true, and Main
  // Admin's call site never overrides it).
  await t.test('a row typed "Admin" is created as an Admin, since Main Admin\'s own Import is the one place that\'s still allowed', async () => {
    const buffer = buildImportBuffer([['Promo', 'ImportRow', 'Admin', '', '', '', '', '', '', '', '', '', '', '']]);
    const res = await request(app).post('/main-admin/members/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'admin-type.xlsx');
    assert.equal(res.status, 302);

    const created = await db.prepare("SELECT member_type FROM members WHERE name = 'Promo ImportRow'").get();
    assert.ok(created, 'the row should still have created a member');
    assert.equal(created.member_type, 'admin');
  });
});

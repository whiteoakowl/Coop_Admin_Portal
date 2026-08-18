// Real HTTP-level coverage for the Members page's new "Import Birthdays"
// feature (routes/admin-members.js's GET /members/import-birthdays-
// template.xlsx + POST /members/import-birthdays). A real user request:
// "Add a button on the member list called import birthdays. This should
// have a spreadsheet with the columns member first name member last name
// abd birthday. The birthdays should import onto the existing member
// pages." - narrower than the full-profile Import (First/Last Name +
// Birthday only), matches EXISTING members only, and always overwrites
// whatever birthday is already on file (confirmed with the user - this
// import's whole purpose is correcting/backfilling birthdays in bulk,
// unlike the full-profile import's "never overwrite" merge rule).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-import-birthdays-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-import-birthdays-test-uploads-${process.pid}`);
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

function buildBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([['First Name', 'Last Name', 'Birthday'], ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('GET /admin/members/import-birthdays-template.xlsx has just the 3 requested columns', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app)
    .get('/admin/members/import-birthdays-template.xlsx')
    .set('Cookie', cookie)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  const wb = XLSX.read(res.body, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(rows[0], ['First Name', 'Last Name', 'Birthday']);
});

test('POST /admin/members/import-birthdays sets/overwrites a matched student, skips a parent match, an unknown name, and a bad date', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const student = await db
    .prepare("INSERT INTO members (name, barcode, member_type, birthday) VALUES ('Birthday Test Student', 'bday-student', 'student', '2010-01-01')")
    .run();
  const parent = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Birthday Test Parent', 'bday-parent', 'parent')")
    .run();

  const buffer = buildBuffer([
    ['Birthday', 'Test Student', '2015-04-12'], // overwrites the student's existing birthday
    ['Birthday', 'Test Parent', '2016-06-06'], // matches a parent - skipped, not applicable
    ['Nobody', 'Here', '2017-07-07'], // no matching active member
    ['Birthday', 'Test Student', 'not-a-date'], // would match, but the date can't be parsed
  ]);

  const res = await request(app)
    .post('/admin/members/import-birthdays?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', buffer, 'birthdays.xlsx');

  assert.equal(res.status, 302);
  const notice = decodeURIComponent(/notice=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /1 birthday\(s\) updated/);
  assert.match(notice, /1 name\(s\) not found/);
  assert.match(notice, /1 matched a parent/);
  assert.match(notice, /1 row\(s\) had an unreadable date/);

  const updatedStudent = await db.prepare('SELECT birthday FROM members WHERE id = ?').get(student.lastInsertRowid);
  assert.equal(updatedStudent.birthday, '2015-04-12', "the student's birthday should be overwritten by the sheet's value");

  const untouchedParent = await db.prepare('SELECT birthday FROM members WHERE id = ?').get(parent.lastInsertRowid);
  assert.equal(untouchedParent.birthday, null, "a parent match shouldn't get a birthday written - the field isn't even shown for parents");
});

test('a U.S.-style M/D/YYYY date string (what a real Excel Date cell reads back as) is accepted, not just ISO', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const student = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Slashdate Test Student', 'bday-slash', 'student')")
    .run();

  const buffer = buildBuffer([['Slashdate', 'Test Student', '4/12/2015']]);
  const res = await request(app)
    .post('/admin/members/import-birthdays?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', buffer, 'birthdays.xlsx');

  assert.equal(res.status, 302);
  const notice = decodeURIComponent(/notice=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /1 birthday\(s\) updated/);

  const updated = await db.prepare('SELECT birthday FROM members WHERE id = ?').get(student.lastInsertRowid);
  assert.equal(updated.birthday, '2015-04-12');
});

// Real bug report: the imported birthday showed on the Members list as
// its raw stored ISO value ("2015-04-12") - reads as a sort key, not a
// birthday. The stored column itself stays ISO (every date comparison/
// sort in this app depends on that sorting correctly as a plain string)
// - only the printed/displayed value changes.
test('an imported birthday displays on the Members print table as MM/DD/YYYY, not the raw stored ISO value', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Display Format Test Student', 'bday-display', 'student')")
    .run();
  const buffer = buildBuffer([['Display', 'Format Test Student', '2015-04-12']]);
  await request(app)
    .post('/admin/members/import-birthdays?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', buffer, 'birthdays.xlsx');

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /04\/12\/2015/, 'the birthday should render as MM\\/DD\\/YYYY');
  assert.doesNotMatch(page.text, /2015-04-12/, 'the raw ISO value should not appear on the page');
});

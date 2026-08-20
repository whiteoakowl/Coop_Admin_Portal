// Real HTTP-level coverage for the new Mass Import Families feature
// (Members page, GET /admin/members/mass-import/sample.xlsx and
// POST /admin/members/mass-import): one row = one whole household -
// primary parent, an optional 2nd parent, and up to 8 children - all
// linked into one new family named after the primary parent's last name,
// instead of the existing full-profile import's one-row-per-member shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-mass-import-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-mass-import-test-uploads-${process.pid}`);
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

const MASS_IMPORT_HEADERS = [
  'Primary Parent First Name', 'Primary Parent Last Name', 'Primary Parent Email',
  '2nd Parent First Name', '2nd Parent Last Name', '2nd Parent Email',
  'Address', 'City', 'State', 'Zip Code', 'Phone Number',
];
for (let i = 1; i <= 8; i++) MASS_IMPORT_HEADERS.push(`Child ${i} First Name`, `Child ${i} Last Name`, `Child ${i} Birthday`, `Child ${i} Grade`);

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([MASS_IMPORT_HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function padRow(cells) {
  const row = cells.slice();
  while (row.length < MASS_IMPORT_HEADERS.length) row.push('');
  return row;
}

test('GET /admin/members/mass-import/sample.xlsx has the exact 43-column layout', async () => {
  const { cookie } = await loginAsAdmin();
  // supertest doesn't buffer an unrecognized (binary xlsx) content-type
  // into res.body by default - force it, same as any other binary
  // download this suite might need to inspect.
  const res = await request(app)
    .get('/admin/members/mass-import/sample.xlsx')
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
  assert.deepEqual(rows[0], MASS_IMPORT_HEADERS);
  assert.equal(MASS_IMPORT_HEADERS.length, 43);
});

test('POST /admin/members/mass-import', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('a full household row creates one family, both parents, and every named child, all linked together', async () => {
    const buffer = buildImportBuffer([
      padRow([
        'Jane', 'Doe', 'jane.doe@example.com', 'John', 'Doe', 'john.doe@example.com',
        '123 Main St', 'Sanford', 'NC', '27330', '555-000-1111',
        'Amy', 'Doe', '2015-04-12', '5th Grade',
        'Ben', 'Doe', '2017-08-03', '3rd Grade',
      ]),
    ]);

    const res = await request(app)
      .post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'families.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const family = await db.prepare('SELECT id FROM families WHERE name = ?').get('Doe');
    assert.ok(family, 'a "Doe" family should have been created from the primary parent\'s last name');

    const members = await db.prepare('SELECT * FROM members WHERE family_id = ? ORDER BY name').all(family.id);
    assert.equal(members.length, 4, 'Jane, John, Amy, Ben');

    const jane = members.find((m) => m.name === 'Jane Doe');
    assert.equal(jane.member_type, 'parent');
    assert.equal(jane.is_primary_parent, 1);
    assert.equal(jane.email, 'jane.doe@example.com');
    assert.equal(jane.address, '123 Main St');

    const john = members.find((m) => m.name === 'John Doe');
    assert.equal(john.member_type, 'parent');
    assert.equal(john.is_primary_parent, 0);
    assert.equal(john.email, 'john.doe@example.com', "the 2nd parent's own email, not the primary parent's");
    assert.equal(john.address, '123 Main St', 'shared household address');

    const amy = members.find((m) => m.name === 'Amy Doe');
    assert.equal(amy.member_type, 'student');
    assert.equal(amy.birthday, '2015-04-12');
    assert.equal(amy.grade_level, '5th Grade');
    assert.equal(amy.email, 'jane.doe@example.com', "a child has no email column, so the primary parent's email is the shared family email");
    assert.equal(amy.phone, '555-000-1111', 'shared household phone');

    const ben = members.find((m) => m.name === 'Ben Doe');
    assert.equal(ben.grade_level, '3rd Grade');

    for (const m of members) {
      assert.match(m.member_code, /^\d{6}$/, `${m.name} should have a 6-digit member_code`);
      assert.equal(m.barcode, m.member_code);
    }
  });

  await t.test('a single-parent row (no 2nd Parent Name) creates just the primary parent + kids, no error', async () => {
    const buffer = buildImportBuffer([padRow(['Maria', 'Lopez', 'maria@example.com', '', '', '', '456 Oak Ave', 'Sanford', 'NC', '27330', '555-222-3333', 'Diego', 'Lopez', '2016-06-20', '4th Grade'])]);
    const res = await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'single-parent.xlsx');
    assert.equal(res.status, 302);

    const family = await db.prepare('SELECT id FROM families WHERE name = ?').get('Lopez');
    const members = (await db.prepare('SELECT name FROM members WHERE family_id = ?').all(family.id)).map((m) => m.name);
    assert.deepEqual(members.sort(), ['Diego Lopez', 'Maria Lopez']);
  });

  await t.test('two unrelated rows with the same last name get two distinct families, not merged into one', async () => {
    const buffer = buildImportBuffer([
      padRow(['Alex', 'Chen', 'alex1@example.com', '', '', '', '1 First St', '', '', '', '', 'Kid', 'Chen', '2018-01-01', '2nd Grade']),
      padRow(['Robin', 'Chen', 'alex2@example.com', '', '', '', '2 Second St', '', '', '', '', 'Other Kid', 'Chen', '2019-01-01', '1st Grade']),
    ]);
    const res = await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'same-surname.xlsx');
    assert.equal(res.status, 302);

    const chenFamilies = (await db.prepare("SELECT name FROM families WHERE name LIKE 'Chen%'").all()).map((f) => f.name);
    assert.equal(chenFamilies.length, 2, 'expected "Chen" and a disambiguated "Chen 2"');
    assert.ok(chenFamilies.includes('Chen'));
    assert.ok(chenFamilies.some((n) => n !== 'Chen'));
  });

  await t.test('a row with no Primary Parent Name is skipped, not imported as a family with no parent', async () => {
    const buffer = buildImportBuffer([padRow(['', '', '', '', '', '', '', '', '', '', '', 'Orphan Row', 'Kid', '2020-01-01', 'Kindergarten'])]);
    const res = await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'blank-primary.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(await db.prepare("SELECT id FROM members WHERE name = 'Orphan Row Kid'").get(), undefined);
  });

  // A real bug report - "importing birthdays comes in as NaN/NaN/NaN" -
  // traced (in part) to this route: unlike the dedicated Import
  // Birthdays route, a child's Birthday cell here used to go straight
  // into the INSERT with no normalizeBirthdayToISO pass, so a genuine
  // Excel Date cell's own formatted text ("4/12/2015", not the ISO
  // "2015-04-12" this column is stored as) got written completely
  // unconverted - formatDateNumeric's parseISO (a plain split('-')) then
  // failed on it, rendering as literal "NaN/NaN/NaN" everywhere that
  // child's birthday was shown. Built with a real Date-typed cell (not a
  // plain string, which every other test in this file uses and which
  // never exercised this bug), matching what actually typing a
  // birthdate into Excel/Sheets produces.
  await t.test('a child Birthday cell from a real Excel Date cell (not already ISO text) is normalized before it\'s stored', async () => {
    const ws = XLSX.utils.aoa_to_sheet(
      [MASS_IMPORT_HEADERS, padRow(['Sam', 'Nguyen', 'sam@example.com', '', '', '', '', '', '', '', '', 'Kid', 'Nguyen', new Date(2015, 3, 12), '5th Grade'])],
      { cellDates: true }
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'nguyen.xlsx');
    assert.equal(res.status, 302);

    const kid = await db.prepare("SELECT birthday FROM members WHERE name = 'Kid Nguyen'").get();
    assert.ok(kid, 'expected the child to still be created even though the birthday needed normalizing');
    assert.equal(kid.birthday, '2015-04-12', 'the raw Excel Date cell text should be normalized to ISO, not stored verbatim');

    // The member profile page uses formatDateNumeric to display it - a
    // stored non-ISO value renders as literal "NaN/NaN/NaN" there, which
    // is exactly the symptom the bug report described.
    const member = await db.prepare("SELECT id FROM members WHERE name = 'Kid Nguyen'").get();
    const profile = await request(app).get(`/admin/members/${member.id}`).set('Cookie', cookie);
    assert.match(profile.text, /04\/12\/2015/);
    assert.doesNotMatch(profile.text, /NaN/);
  });

  await t.test('re-uploading the same file a second time does not create duplicate members, only links them again', async () => {
    const buffer = buildImportBuffer([padRow(['Pat', 'Rivera', 'pat@example.com', '', '', '', '', '', '', '', '', 'Kid', 'Rivera', '2017-05-05', '3rd Grade'])]);
    await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'rivera-1.xlsx');
    const countAfterFirst = Number((await db.prepare("SELECT COUNT(*) AS c FROM members WHERE name IN ('Pat Rivera', 'Kid Rivera')").get()).c);
    assert.equal(countAfterFirst, 2);

    const res = await request(app).post('/admin/members/mass-import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', buffer, 'rivera-2.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
    const countAfterSecond = Number((await db.prepare("SELECT COUNT(*) AS c FROM members WHERE name IN ('Pat Rivera', 'Kid Rivera')").get()).c);
    assert.equal(countAfterSecond, 2, 're-importing the same names must not create duplicate members');
  });
});

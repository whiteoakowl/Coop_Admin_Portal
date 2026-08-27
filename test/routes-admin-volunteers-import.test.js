// Real HTTP-level coverage for Floater Assignments' "Import" feature
// (routes/admin-volunteers.js's POST /volunteers/:day/import, sample file
// from routes/admin.js's GET /import-template/names.xlsx) after its single
// Name column was split into separate First/Last Name columns - matched by
// column position (utils/members.js's parseNamesFromUpload/parseNamesFile),
// then joined into the single "First Last" string every member is stored
// as, so the exact-name match against active parents keeps working
// unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-import-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-import-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

// /admin/members/new-single (a flat {name, memberType} fixture route) was
// removed - "there shouldn't be any lone admins/leaders, or single
// members" - so this fixture now goes through the real family-intake
// form (/admin/members/new) instead, with a throwaway filler entry on
// the side it doesn't care about (createParentMember/createChildMember
// never enforce name uniqueness, so a constant filler name is safe to
// reuse across calls).
async function addSingleMember(cookie, csrfToken, name, memberType) {
  const body = { newFamilyName: `${name} Family`, _csrf: csrfToken };
  if (memberType === 'parent') {
    body['parents[0][name]'] = name;
    body['children[0][name]'] = 'Filler Child';
  } else {
    body['parents[0][name]'] = 'Filler Parent';
    body['children[0][name]'] = name;
  }
  return request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send(body);
}

test('GET /admin/import-template/names.xlsx has separate First/Last Name columns', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app)
    .get('/admin/import-template/names.xlsx')
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
  assert.deepEqual(rows[0], ['First Name', 'Last Name']);
});

test('POST /admin/volunteers/monday/import matches an active parent by joining First/Last Name columns', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await addSingleMember(cookie, csrfToken, 'Robin Floater', 'parent');

  await t.test('an .xlsx file with First/Last Name columns', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['First Name', 'Last Name'], ['Robin', 'Floater']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await request(app)
      .post('/admin/volunteers/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'floaters.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 1 member(s) added'));

    const member = await db.prepare("SELECT id FROM members WHERE name = 'Robin Floater'").get();
    const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
    const onList = await db.prepare('SELECT 1 FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?').get(list.id, member.id);
    assert.ok(onList, 'the matched member should have been added to the floater list');
  });

  await t.test('a plain .csv file with First Name,Last Name columns (header row skipped, not imported as a name)', async () => {
    const csv = 'First Name,Last Name\nRobin,Floater\n';
    const res = await request(app)
      .post('/admin/volunteers/wednesday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', Buffer.from(csv), 'floaters.csv');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 1 member(s) added'), 'the header row must not be misread as a name');
  });
});

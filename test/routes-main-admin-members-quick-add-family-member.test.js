// Real request: "when editing a member profile, there is a button that
// says add parent/student. when you click this button it will ask
// student or parent, name, if student then it asks birthday and grade.
// save." Main Admin's own Edit Profile page (views/main-admin-member-
// edit.ejs) has a "+ Add Parent/Student" dialog that always adds onto
// the member's own family via routes/main-admin-members.js's own
// POST /:id/quick-add-family-member - each new person still gets their
// own individual profile, same as every other "add a member" entry
// point, just with far fewer fields collected (no address/email/phone/
// setup team/custom fields).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-quick-add-family-member-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-quick-add-family-member-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Edit Profile page renders the quick-add dialog for a member with a family, asking Student/Parent, Name, and (Student only) Birthday/Grade', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Quick Add Test')").run()).lastInsertRowid;
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Quick Add Parent', 'quick-add-parent', 'parent', ?, 1)").run(familyId)
  ).lastInsertRowid;

  const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /data-quick-add-member-open[^>]*>\+ Add Parent\/Student</);
  const dialogMatch = /<dialog class="member-picker-dialog" data-quick-add-member-dialog>[\s\S]*?<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'expected the quick-add dialog markup');
  const dialogHtml = dialogMatch[0];
  assert.match(dialogHtml, new RegExp(`action="/main-admin/members/${memberId}/quick-add-family-member"`));
  assert.match(dialogHtml, /value="student" checked/);
  assert.match(dialogHtml, /value="parent"/);
  assert.match(dialogHtml, /name="name"/);
  assert.match(dialogHtml, /name="birthday"/);
  assert.match(dialogHtml, /name="gradeLevel"/);
});

test('a member with no family yet gets no quick-add button (nothing to add onto)', async () => {
  const cookie = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Family Member', 'quick-add-no-fam', 'parent')").run()).lastInsertRowid;

  const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /data-quick-add-member-open/);
  assert.match(res.text, /Choose or add a family above and save/);
});

test('POST .../quick-add-family-member with memberType=student creates a student with birthday/grade on the same family, using the parent\'s own address', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Quick Add Student Family')").run()).lastInsertRowid;
  const parentId = (
    await db
      .prepare(
        "INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, address, city, state, zip) VALUES ('Student Family Parent', 'quick-add-student-parent', 'parent', ?, 1, '123 Main St', 'Springfield', 'IL', '62701')"
      )
      .run(familyId)
  ).lastInsertRowid;

  const res = await request(app)
    .post(`/main-admin/members/${parentId}/quick-add-family-member`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberType: 'student', name: 'Quick Add Kid', birthday: '2015-04-12', gradeLevel: '3rd', _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /^\/main-admin\/members\/\d+\/edit\?notice=Quick Add Kid added to the family\.$/);

  const row = await db.prepare("SELECT * FROM members WHERE name = 'Quick Add Kid'").get();
  assert.ok(row);
  assert.equal(row.member_type, 'student');
  assert.equal(row.family_id, familyId);
  assert.equal(row.birthday, '2015-04-12');
  assert.equal(row.grade_level, '3rd');
  assert.equal(row.address, '123 Main St');
  assert.equal(row.city, 'Springfield');
  assert.equal(row.state, 'IL');
  assert.equal(row.zip, '62701');
});

test('POST .../quick-add-family-member with memberType=parent creates a non-primary parent, ignoring birthday/grade, using the same address', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Quick Add Parent Family')").run()).lastInsertRowid;
  const existingParentId = (
    await db
      .prepare(
        "INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, address, city, state, zip) VALUES ('Existing Primary Parent', 'quick-add-existing-parent', 'parent', ?, 1, '456 Oak Ave', 'Riverside', 'CA', '92501')"
      )
      .run(familyId)
  ).lastInsertRowid;

  const res = await request(app)
    .post(`/main-admin/members/${existingParentId}/quick-add-family-member`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberType: 'parent', name: 'Second Parent', birthday: '2015-04-12', gradeLevel: '3rd', _csrf: csrfToken });

  assert.equal(res.status, 302);

  const row = await db.prepare("SELECT * FROM members WHERE name = 'Second Parent'").get();
  assert.ok(row);
  assert.equal(row.member_type, 'parent');
  assert.equal(row.family_id, familyId);
  assert.equal(row.is_primary_parent, 0);
  assert.equal(row.birthday, null);
  assert.equal(row.grade_level, null);
  assert.equal(row.address, '456 Oak Ave');
  assert.equal(row.city, 'Riverside');
  assert.equal(row.state, 'CA');
  assert.equal(row.zip, '92501');
});

test('POST .../quick-add-family-member on a member with a blank address still succeeds, leaving the new member\'s address blank too', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Quick Add No Address Family')").run()).lastInsertRowid;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('No Address Parent', 'quick-add-no-address-parent', 'parent', ?, 1)")
      .run(familyId)
  ).lastInsertRowid;

  const res = await request(app)
    .post(`/main-admin/members/${parentId}/quick-add-family-member`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberType: 'student', name: 'No Address Kid', _csrf: csrfToken });

  assert.equal(res.status, 302);
  const row = await db.prepare("SELECT * FROM members WHERE name = 'No Address Kid'").get();
  assert.ok(row);
  assert.equal(row.address, null);
  assert.equal(row.city, null);
});

test('POST .../quick-add-family-member with no name is rejected, nothing created', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Quick Add No Name Family')").run()).lastInsertRowid;
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('No Name Test Parent', 'quick-add-no-name-parent', 'parent', ?, 1)").run(familyId)
  ).lastInsertRowid;

  const before = Number((await db.prepare('SELECT COUNT(*) AS n FROM members WHERE family_id = ?').get(familyId)).n);

  const res = await request(app)
    .post(`/main-admin/members/${parentId}/quick-add-family-member`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberType: 'student', name: '', _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /error=Name is required\./);

  const after = Number((await db.prepare('SELECT COUNT(*) AS n FROM members WHERE family_id = ?').get(familyId)).n);
  assert.equal(after, before);
});

test('POST .../quick-add-family-member on a member with no family yet is rejected', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const lonerId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Loner No Family', 'quick-add-loner', 'parent')").run()).lastInsertRowid;

  const res = await request(app)
    .post(`/main-admin/members/${lonerId}/quick-add-family-member`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberType: 'student', name: 'Should Not Be Created', _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /error=This member has no family yet/);
  const row = await db.prepare("SELECT 1 AS ok FROM members WHERE name = 'Should Not Be Created'").get();
  assert.equal(row, undefined);
});

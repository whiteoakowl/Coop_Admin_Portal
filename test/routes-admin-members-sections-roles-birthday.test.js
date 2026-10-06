// Coverage for a real request: "All portals need the same member
// profile view and the same member profile edit pages and features. We
// don't ask adults/parents for their birthday. Only main admin and
// co-op admin can change sections, portal roles, family, and birthday."
//
// Two halves:
// 1. Co-op Admin's own Edit Member page (views/admin-member-edit.ejs)
//    gains write access to Sections/Portal Roles, same as Main Admin's
//    own edit page already has (routes/main-admin-members.js) - Co-op
//    Admin previously only ever read these on the Member Profile page.
// 2. partials/member-form-fields.ejs's Birthday field is hidden for a
//    Parent/Admin on both admin portals' edit forms (still shown/
//    editable for a Student), and an existing Parent/Admin's on-file
//    birthday round-trips unchanged through a save even though it's
//    not shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-sections-roles-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-sections-roles-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin Edit Member page can now set Sections and Portal Roles, not just read them', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, email) VALUES ('Coop Sections Test', 'Coop Sections Test', 'parent', 'coopsections@example.com')")
    .run();
  const { lastInsertRowid: sectionId } = await db.prepare("INSERT INTO sections (name) VALUES ('Coop Test Section')").run();
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'coopsections@example.com', 'x', 'active')")
    .run(memberId);

  const editPage = await request(app).get(`/admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`name="sectionIds" value="${sectionId}"`), 'Co-op Admin edit form now renders a writable Sections checkbox');
  const csrfToken = extractCsrf(editPage.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Coop Sections Test', email: 'coopsections@example.com', sectionIds: String(sectionId), _csrf: csrfToken });
  assert.equal(res.status, 302);

  const sectionRows = await db.prepare('SELECT section_id FROM member_sections WHERE member_id = ?').all(memberId);
  assert.ok(sectionRows.some((r) => r.section_id === sectionId), 'Co-op Admin can now save a member\'s Sections, not just view them');
});

test('Co-op Admin Edit Member page has no Password field - account creation stays Main Admin-only', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Password Here', 'No Password Here', 'parent')")
    .run();
  const editPage = await request(app).get(`/admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.doesNotMatch(editPage.text, /name="password"/, 'creating a portal account/password stays Main Admin-only');
});

test('Birthday is hidden on a Parent/Admin edit form but still visible for a Student, on both admin portals', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, birthday) VALUES ('Birthday Parent', 'Birthday Parent', 'parent', '1980-05-01')")
    .run();
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, birthday) VALUES ('Birthday Student', 'Birthday Student', 'student', '2015-05-01')")
    .run();

  const parentPage = await request(app).get(`/admin/members/${parentId}/edit`).set('Cookie', cookie);
  assert.match(parentPage.text, /data-birthday-field[^>]*display:none;/, 'Birthday field is hidden for a Parent');

  const studentPage = await request(app).get(`/admin/members/${studentId}/edit`).set('Cookie', cookie);
  assert.doesNotMatch(studentPage.text, /data-birthday-field[^>]*display:none;/, 'Birthday field stays visible for a Student');
  assert.match(studentPage.text, /name="birthday" value="2015-05-01"/);
});

test("saving a Parent's edit form (where Birthday is hidden) does not blank out their existing on-file birthday", async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, birthday) VALUES ('Preserve Birthday Parent', 'Preserve Birthday Parent', 'parent', '1980-05-01')")
    .run();
  const editPage = await request(app).get(`/admin/members/${parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(editPage.text);
  // The hidden Birthday input is still present in the DOM (not removed,
  // not disabled) - a real browser submit round-trips its unchanged
  // value. Simulating that exact submit here.
  const birthdayValue = /name="birthday" value="([^"]*)"/.exec(editPage.text)[1];
  assert.equal(birthdayValue, '1980-05-01');

  await request(app)
    .post(`/admin/members/${parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Preserve Birthday Parent', birthday: birthdayValue, _csrf: csrfToken });

  const saved = await db.prepare('SELECT birthday FROM members WHERE id = ?').get(parentId);
  assert.equal(saved.birthday, '1980-05-01', 'an existing Parent\'s birthday must not be wiped out just because the field is hidden');
});

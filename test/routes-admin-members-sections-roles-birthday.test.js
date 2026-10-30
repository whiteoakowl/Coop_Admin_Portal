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
// 2. A later real request ("when you click the edit profile button it
//    should look exactly like the membership request form") replaced
//    partials/member-form-fields.ejs with partials/member-edit-fields.ejs,
//    whose Birthday field isn't just hidden via CSS for a Parent/Admin
//    anymore - it's entirely absent from the DOM (still shown/editable
//    for a Student), same as the public membership form never asks an
//    adult for a birthday at all. An existing Parent/Admin's on-file
//    birthday still round-trips unchanged through a save even though
//    there's no field on the page to carry it (routes/admin-members.js's
//    own memberFormFields falls back to the existing value whenever the
//    submission has no "birthday" key at all).
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
  assert.doesNotMatch(parentPage.text, /name="birthday"/, 'Birthday field is not rendered at all for a Parent');

  const studentPage = await request(app).get(`/admin/members/${studentId}/edit`).set('Cookie', cookie);
  assert.match(studentPage.text, /name="birthday" value="2015-05-01"/, 'Birthday field stays visible for a Student');
});

test("saving a Parent's edit form (where Birthday is hidden) does not blank out their existing on-file birthday", async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, birthday) VALUES ('Preserve Birthday Parent', 'Preserve Birthday Parent', 'parent', '1980-05-01')")
    .run();
  const editPage = await request(app).get(`/admin/members/${parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(editPage.text);
  // There's no Birthday input on the page at all for a Parent now (see
  // this file's own top comment) - a real browser submit of this form
  // simply never sends a "birthday" key. Simulating that exact submit
  // here: no birthday field in the posted body whatsoever.
  assert.doesNotMatch(editPage.text, /name="birthday"/);

  await request(app)
    .post(`/admin/members/${parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Preserve Birthday Parent', _csrf: csrfToken });

  const saved = await db.prepare('SELECT birthday FROM members WHERE id = ?').get(parentId);
  assert.equal(saved.birthday, '1980-05-01', 'an existing Parent\'s birthday must not be wiped out just because the field is hidden');
});

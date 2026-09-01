// Coverage for three related Main Admin Members changes, all from the
// same real request thread:
//
// 1. "when you click on the member it shows their profile. class
//    schedule and attendance should be tabs. there should not be an
//    edit permissions button, it should just show the members sections
//    and portal permissions. When you click the edit button on the
//    member's profile that is where you can control portal settings per
//    member." -> the profile page (routes/main-admin-members.js's GET
//    /:id) is now Profile/Class Schedule/Attendance tabs, its Portal
//    Permissions card is read-only with no "Edit Permissions" link, and
//    the per-member Edit page now also manages Sections (not just
//    Portal Roles/password).
//
// 2. "make every member a user... give everyone the password
//    changeme123. all members will have accounts." -> POST /main-admin/
//    members/bulk-create-accounts.
//
// 3. "take away user settings" -> the standalone Users settings tab
//    (routes/main-admin.js's old /users, /users/:id/roles, /users/:id/
//    approve, /users/:id/suspend, /users/:id/reactivate, /users/new) is
//    gone entirely - every member's account is now managed from their
//    own profile, and membership/account approval already lives at
//    Members > Approvals (utils/membershipApprovals.js, unaffected).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-profile-accounts-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-profile-accounts-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { verifyPassword } = require('../utils/portalAuth');

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

test('the Users settings tab is gone: no route, no tab link, no dashboard/nav dead links', async () => {
  const cookie = await loginAsMainAdmin();

  const usersPage = await request(app).get('/main-admin/users').set('Cookie', cookie);
  assert.equal(usersPage.status, 404);

  const usersNew = await request(app).get('/main-admin/users/new').set('Cookie', cookie);
  assert.equal(usersNew.status, 404);

  const settingsRedirect = await request(app).get('/main-admin/settings').set('Cookie', cookie);
  assert.equal(settingsRedirect.status, 302);
  assert.match(settingsRedirect.headers.location, /\/main-admin\/roles/);

  const rolesPage = await request(app).get('/main-admin/roles').set('Cookie', cookie);
  assert.equal(rolesPage.status, 200);
  assert.doesNotMatch(rolesPage.text, /href="\/main-admin\/users"/);

  const home = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.text, /\/main-admin\/users/);
});

test('member profile page has Profile/Class Schedule/Attendance tabs, no Edit Permissions button', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tab Test Parent', 'Tab Test Parent', 'parent')")
    .run();

  const profile = await request(app).get(`/main-admin/members/${memberId}`).set('Cookie', cookie);
  assert.equal(profile.status, 200);
  assert.match(profile.text, /<a class="view-tab active" href="\/main-admin\/members\/\d+\?tab=profile">Profile<\/a>/);
  assert.match(profile.text, /Class Schedule/);
  assert.match(profile.text, /Attendance/);
  assert.doesNotMatch(profile.text, /Edit Permissions/);
  assert.match(profile.text, /href="\/main-admin\/members\/\d+\/edit"[^>]*>[\s\S]*?Edit/);

  const scheduleTab = await request(app).get(`/main-admin/members/${memberId}?tab=schedule`).set('Cookie', cookie);
  assert.equal(scheduleTab.status, 200);
  assert.match(scheduleTab.text, /<a class="view-tab active" href="\/main-admin\/members\/\d+\?tab=schedule">Class Schedule<\/a>/);
  assert.match(scheduleTab.text, /No classes on Monday yet\./);

  const attendanceTab = await request(app).get(`/main-admin/members/${memberId}?tab=attendance`).set('Cookie', cookie);
  assert.equal(attendanceTab.status, 200);
  assert.match(attendanceTab.text, /<a class="view-tab active" href="\/main-admin\/members\/\d+\?tab=attendance">Attendance<\/a>/);
  assert.match(attendanceTab.text, /No attendance recorded yet\./);
});

test('the per-member Edit page manages Sections alongside Portal Roles and password', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, email) VALUES ('Sections Edit Test', 'Sections Edit Test', 'parent', 'sectionsedit@example.com')")
    .run();
  const { lastInsertRowid: sectionId } = await db.prepare("INSERT INTO sections (name) VALUES ('Test Section')").run();

  const editPage = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`name="sectionIds" value="${sectionId}"`));
  const csrfToken = extractCsrf(editPage.text);

  await request(app)
    .post(`/main-admin/members/${memberId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Sections Edit Test', memberType: 'parent', email: 'sectionsedit@example.com', sectionIds: String(sectionId), _csrf: csrfToken });

  const profile = await request(app).get(`/main-admin/members/${memberId}`).set('Cookie', cookie);
  assert.match(profile.text, /Test Section/);
});

test('bulk-create-accounts creates password "changeme123" accounts for members without one, skips those with no email', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: withEmailId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, email) VALUES ('Bulk Create Me', 'Bulk Create Me', 'parent', 'bulkcreate@example.com')")
    .run();
  const { lastInsertRowid: noEmailId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bulk No Email', 'Bulk No Email', 'student')")
    .run();
  const { lastInsertRowid: alreadyHasId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, email) VALUES ('Bulk Already Has One', 'Bulk Already Has One', 'parent', 'alreadyhas@example.com')")
    .run();
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'alreadyhas@example.com', 'x', 'active')")
    .run(alreadyHasId);

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  const res = await request(app).post('/main-admin/members/bulk-create-accounts').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const created = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(withEmailId);
  assert.ok(created, 'a member with an email and no prior account should get one');
  assert.equal(created.status, 'active');
  assert.ok(await verifyPassword(created, 'changeme123'));

  const skipped = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(noEmailId);
  assert.equal(skipped, undefined, 'a member with no email cannot get an account');

  const untouchedCountRow = await db.prepare('SELECT COUNT(*) AS c FROM member_accounts WHERE member_id = ?').get(alreadyHasId);
  assert.equal(Number(untouchedCountRow.c), 1, 'a member who already has an account is left alone, not duplicated');
});

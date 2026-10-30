// Coverage for the Parent Portal's own Edit Profile page (a real request:
// "when parent portal clicks the profile button, keep the current
// profile view. When you click the edit profile button it should look
// exactly like the membership request form. Exactly." plus a follow-up
// clarification, "Remove it, password lives in Edit Profile" - replacing
// the standalone Password tab test/routes-portal-profile.test.js used to
// cover). GET /portal/profile/edit and POST /portal/profile/edit live in
// routes/portal-auth.js; the shared field set/styling comes from
// partials/member-edit-fields.ejs (also used by both admin portals' own
// Edit Member pages).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-profile-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-profile-edit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');

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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Profile Edit Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const email = `profile-edit-test-parent-${familyCounter}@example.com`;
  const password = 'testpassword123';
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Profile Edit Test Parent ${familyCounter}`, code, code, familyId);
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal/profile/edit' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/portal/profile/edit').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, email };
}

test('GET /portal/profile/edit looks like the membership request form - Photo, Name, contact fields, and a Password/Confirm Password pair', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile/edit').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<input type="file" name="photo"/);
  assert.match(page.text, new RegExp(`value="Profile Edit Test Parent ${familyCounter}"`));
  assert.match(page.text, /<input type="password" name="password"/);
  assert.match(page.text, /<input type="password" name="confirmPassword"/);
  // A parent is never a Student, so Birthday/Grade Level never appear.
  assert.doesNotMatch(page.text, /name="birthday"/);
  // Admin-only Family/Sections/Portal Roles controls never appear here.
  assert.doesNotMatch(page.text, /name="familyId"/);
});

test('leaving the password fields blank keeps the existing password unchanged', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/edit')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: `Profile Edit Test Parent ${familyCounter}`, _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const stillWorks = await request(app).post('/login').type('form').send({ email: parent.email, password: 'testpassword123', next: '/portal/profile' });
  assert.equal(stillWorks.status, 302, 'the original password still logs in');
});

test('setting a new password through Edit Profile succeeds and the new password logs in', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/edit')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: `Profile Edit Test Parent ${familyCounter}`, password: 'brandnewpassword456', confirmPassword: 'brandnewpassword456', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const oldPasswordLogin = await request(app).post('/login').type('form').send({ email: parent.email, password: 'testpassword123', next: '/portal/profile' });
  assert.match(oldPasswordLogin.text, /Incorrect email or password/, 'the old password no longer works');

  const newPasswordLogin = await request(app).post('/login').type('form').send({ email: parent.email, password: 'brandnewpassword456', next: '/portal/profile' });
  assert.equal(newPasswordLogin.status, 302);
  assert.match(newPasswordLogin.headers.location, /\/portal\/profile/);
});

test('a new password under 8 characters fails with an error and leaves the password unchanged', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/edit')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: `Profile Edit Test Parent ${familyCounter}`, password: 'short', confirmPassword: 'short', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);

  const stillWorks = await request(app).post('/login').type('form').send({ email: parent.email, password: 'testpassword123', next: '/portal/profile' });
  assert.equal(stillWorks.status, 302, 'the original password still logs in');
});

test('mismatched new/confirm password fields fail with an error and leave the password unchanged', async () => {
  const parent = await createParentAccount();
  const res = await request(app)
    .post('/portal/profile/edit')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: `Profile Edit Test Parent ${familyCounter}`, password: 'brandnewpassword456', confirmPassword: 'somethingelse789', _csrf: parent.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);

  const stillWorks = await request(app).post('/login').type('form').send({ email: parent.email, password: 'testpassword123', next: '/portal/profile' });
  assert.equal(stillWorks.status, 302, 'the original password still logs in');
});

test('signing out and hitting the Edit Profile page redirects to login', async () => {
  const res = await request(app).get('/portal/profile/edit');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});

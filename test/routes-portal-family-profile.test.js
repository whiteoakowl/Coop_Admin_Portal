// Real HTTP-level coverage for a real request: "Member profile for
// co-op admin portal, main admin portal, parent portal should match the
// image attached," with the entry point answered as "Click a family
// member's name to open it." Covers both the new "My Family" list on
// /portal/profile and the new read-only /portal/family/:memberId page
// itself, plus the family-scoping security boundary (a parent must never
// be able to view a member outside their own family by guessing an id).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-family-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-family-profile-test-uploads-${process.pid}`);
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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Family Profile Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Family Profile Parent ${familyCounter}`, code, code, familyId);
  const email = `family-profile-parent-${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, grade_level) VALUES (?, ?, ?, 'student', ?, 1, '3rd Grade')")
    .run(`Family Profile Kid ${familyCounter}`, await generateMemberCode(), code + '-kid', familyId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal/profile' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie, familyId, parentId: parentInfo.lastInsertRowid, studentId: studentInfo.lastInsertRowid };
}

test('My Profile page lists other family members as clickable names into /portal/family/:id', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`<a href="/portal/family/${parent.studentId}">Family Profile Kid ${familyCounter}</a>`));
  // The viewer's own name never appears in their own "My Family" list.
  assert.doesNotMatch(page.text, new RegExp(`href="/portal/family/${parent.parentId}"`));
});

test('clicking a family member\'s name renders the shared Member Profile card, with an Edit link into its own edit page', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get(`/portal/family/${parent.studentId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Member Profile/);
  assert.match(page.text, new RegExp(`Family Profile Kid ${familyCounter}`));
  assert.match(page.text, /3rd Grade/);
  // A later real request: "When clicking on a child or adult profile
  // there it should allow parent to edit their profiles as well, not
  // just view" - unlike the old read-only behavior, an Edit link into
  // /portal/family/:id/edit now appears in the banner, same as Co-op/
  // Main Admin's own version of this shared partial.
  assert.match(page.text, new RegExp(`roster-action-btn" href="/portal/family/${parent.studentId}/edit"`));
});

test('a parent can edit a family member\'s contact info, but never their birthday/grade level/member type', async () => {
  const parent = await createParentAccount();
  const editPage = await request(app).get(`/portal/family/${parent.studentId}/edit`).set('Cookie', parent.cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`value="Family Profile Kid ${familyCounter}"`));
  assert.match(editPage.text, /disabled/, 'birthday/grade level still render disabled on this form too');

  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(editPage.text)[1];
  const res = await request(app)
    .post(`/portal/family/${parent.studentId}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Family Profile Kid Updated', phone: '555-4321', medicalNotes: 'Peanut allergy', birthday: '2000-01-01', gradeLevel: '9th Grade', memberType: 'admin', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const updated = await db.prepare('SELECT name, phone, medical_notes, birthday, grade_level, member_type FROM members WHERE id = ?').get(parent.studentId);
  assert.equal(updated.name, 'Family Profile Kid Updated');
  assert.equal(updated.phone, '555-4321');
  assert.equal(updated.medical_notes, 'Peanut allergy');
  assert.equal(updated.grade_level, '3rd Grade', 'grade level must never change through this route');
  assert.equal(updated.member_type, 'student', 'member type can never be spoofed to admin through this route');
});

// A real request: "Be able to change student's email when editing
// student profile" - the plain Email field above is just contact info
// (members.email), so this is the actual sign-in credential
// (member_accounts.email) a student logs in with.
test('a parent can change a student\'s login email when the student has a portal account, with uniqueness enforced', async () => {
  const parent = await createParentAccount();
  const studentAccountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parent.studentId, `student-login-${familyCounter}@example.com`, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(studentAccountInfo.lastInsertRowid, studentRole.id);

  const editPage = await request(app).get(`/portal/family/${parent.studentId}/edit`).set('Cookie', parent.cookie);
  assert.match(editPage.text, new RegExp(`name="loginEmail" value="student-login-${familyCounter}@example.com"`));

  const otherFamilyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Other Login Email Family')).lastInsertRowid;
  const otherMemberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Someone Else', ?, ?, 'parent', ?, 1)").run(await generateMemberCode(), await generateMemberCode(), otherFamilyId)
  ).lastInsertRowid;
  const takenEmail = `already-taken-${familyCounter}@example.com`;
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())").run(otherMemberId, takenEmail, hashPassword('testpassword123'));

  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(editPage.text)[1];
  const collision = await request(app)
    .post(`/portal/family/${parent.studentId}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Family Profile Kid', loginEmail: takenEmail, _csrf: csrfToken });
  assert.match(collision.headers.location, /error=/);
  let account = await db.prepare('SELECT email FROM member_accounts WHERE id = ?').get(studentAccountInfo.lastInsertRowid);
  assert.equal(account.email, `student-login-${familyCounter}@example.com`, 'a colliding email must never be saved');

  const res = await request(app)
    .post(`/portal/family/${parent.studentId}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Family Profile Kid', loginEmail: `new-student-login-${familyCounter}@example.com`, _csrf: csrfToken });
  assert.match(res.headers.location, /notice=/);
  account = await db.prepare('SELECT email FROM member_accounts WHERE id = ?').get(studentAccountInfo.lastInsertRowid);
  assert.equal(account.email, `new-student-login-${familyCounter}@example.com`);
});

test('a parent cannot view or edit another family\'s member by guessing an id', async () => {
  const parent = await createParentAccount();
  const otherFamily = await createParentAccount();

  const getRes = await request(app).get(`/portal/family/${otherFamily.studentId}/edit`).set('Cookie', parent.cookie);
  assert.equal(getRes.status, 404);

  const ownPage = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(ownPage.text)[1];
  const postRes = await request(app)
    .post(`/portal/family/${otherFamily.studentId}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ name: 'Hijacked Name', _csrf: csrfToken });
  assert.equal(postRes.status, 404);
  const untouched = await db.prepare('SELECT name FROM members WHERE id = ?').get(otherFamily.studentId);
  assert.notEqual(untouched.name, 'Hijacked Name');
});

test('a parent cannot view a member outside their own family by guessing an id', async () => {
  const parent = await createParentAccount();
  const otherFamily = await createParentAccount();

  const res = await request(app).get(`/portal/family/${otherFamily.studentId}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 404);
});

test('signed-out visitors are redirected to login', async () => {
  const parent = await createParentAccount();
  const res = await request(app).get(`/portal/family/${parent.studentId}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});

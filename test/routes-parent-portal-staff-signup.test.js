// Coverage for a real request: "Where an assistant is needed in a class
// its not showing parent name to register" - traced to Parent Portal's
// own class view (views/parent-class-fragment.ejs) only ever letting a
// parent register their CHILDREN for a class, never themselves as
// Teacher/Assistant. That self-signup only existed on the separate
// Teacher Portal's own "Sign Up to Teach" page, which requires the
// account to already have a 'teacher' portal role - an ordinary parent
// account could never reach it. Adds the same self-signup directly to
// the Parent Portal class view (POST /parent/classes/:id/join), sharing
// utils/classRegistration.js's own joinClassAsStaff with Teacher Portal's
// route so neither can drift from the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-portal-staff-signup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-portal-staff-signup-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let classCounter = 0;
async function createClass(admin, overrides) {
  classCounter += 1;
  const className = (overrides && overrides.className) || `Staff Signup Class ${classCounter}`;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      className,
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await db.prepare('UPDATE classes SET registration_open = 1 WHERE id = ?').run(cls.id);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Staff Signup Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Staff Signup Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Staff Signup Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `staff-signup-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text), childId: childInfo.lastInsertRowid, memberId: parentInfo.lastInsertRowid };
}

test('Parent Portal class fragment offers Register as Teacher/Assistant buttons posting to /parent/classes/:id/join', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin);
  const parent = await createParentWithChild();

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  assert.match(fragment.text, new RegExp(`<form method="POST" action="/parent/classes/${cls.id}/join"[^>]*>\\s*<input type="hidden" name="role" value="teacher"`));
  assert.match(fragment.text, new RegExp(`<form method="POST" action="/parent/classes/${cls.id}/join"[^>]*>\\s*<input type="hidden" name="role" value="assistant"`));
  assert.match(fragment.text, />Register as Teacher</);
  assert.match(fragment.text, />Register as Assistant</);
});

test('A parent can register themselves as an assistant directly from Parent Portal, with no separate Teacher Portal role', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Self Signup Assistant Class' });
  const parent = await createParentWithChild();

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'assistant', day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /notice=Signed up as assistant/);

  const staffRow = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, parent.memberId);
  assert.ok(staffRow, 'expected a class_staff row for the parent themselves, not a child');
  assert.equal(staffRow.role, 'assistant');
});

test('Once self-registered, the fragment shows "signed up as" instead of the registration buttons', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Already Staffed Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'teacher', day: 'monday', _csrf: parent.csrfToken });

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  assert.match(fragment.text, /You're signed up as a Teacher for this class/);
  // The h4 heading itself always reads "Register as Teacher/Assistant" -
  // these check for the actual BUTTON text (anchored with a trailing
  // "<"), which must be gone once already staffed.
  assert.doesNotMatch(fragment.text, />Register as Teacher</);
  assert.doesNotMatch(fragment.text, />Register as Assistant</);
});

test('Registering twice for the same class is rejected', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Double Signup Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'assistant', day: 'monday', _csrf: parent.csrfToken });
  const second = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'teacher', day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(second.headers.location), /already staffed/);
});

test('Once assistant_slots is full, the Register as Assistant button disappears for other parents but Teacher stays available', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Full Assistant Slots Class', assistantSlots: '1' });
  const firstParent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', firstParent.cookie)
    .type('form')
    .send({ role: 'assistant', day: 'monday', _csrf: firstParent.csrfToken });

  const secondParent = await createParentWithChild();
  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', secondParent.cookie);
  assert.doesNotMatch(fragment.text, /Register as Assistant/);
  assert.match(fragment.text, /Register as Teacher/);

  const blocked = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', secondParent.cookie)
    .type('form')
    .send({ role: 'assistant', day: 'monday', _csrf: secondParent.csrfToken });
  assert.match(decodeURIComponent(blocked.headers.location), /already has its full 1 assistant/);
});

test('A registration window scoped to only "parent_register_student" does not block a parent self-registering as teacher/assistant', async () => {
  await db.prepare('DELETE FROM registration_windows').run();
  const { createWindow } = require('../utils/registrationWindows');
  await createWindow({ label: 'Student Registration Only', opensAt: '2020-01-01 00:00:00', closesAt: null, actionTypes: ['parent_register_student'] });

  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Window Independence Class' });
  const parent = await createParentWithChild();

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'assistant', day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /notice=/);
  await db.prepare('DELETE FROM registration_windows').run();
});

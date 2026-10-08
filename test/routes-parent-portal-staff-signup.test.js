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
    .send({ role: 'assistant', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /notice=Signed up as assistant/);

  const staffRow = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, parent.memberId);
  assert.ok(staffRow, 'expected a class_staff row for the parent themselves, not a child');
  assert.equal(staffRow.role, 'assistant');
});

test('Once self-registered, the fragment shows the member\'s own name + role badge + a Withdraw button instead of the registration buttons', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Already Staffed Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  const parentMember = await db.prepare('SELECT name FROM members WHERE id = ?').get(parent.memberId);
  assert.match(fragment.text, new RegExp(`<span class="parent-class-child-name-text">${parentMember.name}</span>`));
  assert.match(fragment.text, />Teacher<\/span>/);
  assert.match(fragment.text, new RegExp(`action="/parent/classes/${cls.id}/leave"`));
  assert.match(fragment.text, />Withdraw</);
  // The h4 heading itself always reads "Register as Teacher/Assistant" -
  // these check for the actual BUTTON text (anchored with a trailing
  // "<"), which must be gone once already staffed.
  assert.doesNotMatch(fragment.text, />Register as Teacher</);
  assert.doesNotMatch(fragment.text, />Register as Assistant</);
});

test('A real request: "there needs to also be a withdraw button for the teacher assistant" - POST /classes/:id/leave removes the self-signup and the Register buttons come back', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Withdraw Staff Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'assistant', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });

  const leave = await request(app)
    .post(`/parent/classes/${cls.id}/leave`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(leave.headers.location), /notice=/);

  const staffRow = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, parent.memberId);
  assert.equal(staffRow, undefined, 'the class_staff row should be gone');

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  assert.match(fragment.text, />Register as Assistant</);
  assert.doesNotMatch(fragment.text, new RegExp(`action="/parent/classes/${cls.id}/leave"`));
});

test('Leaving a class you were never staffed on is rejected', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Never Staffed Class' });
  const parent = await createParentWithChild();

  const leave = await request(app)
    .post(`/parent/classes/${cls.id}/leave`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(leave.headers.location), /You are not signed up for that class/);
});

test('Registering twice for the same class is rejected', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Double Signup Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'assistant', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  const second = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
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
    .send({ role: 'assistant', memberId: firstParent.memberId, day: 'monday', _csrf: firstParent.csrfToken });

  const secondParent = await createParentWithChild();
  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', secondParent.cookie);
  assert.doesNotMatch(fragment.text, /Register as Assistant/);
  assert.match(fragment.text, /Register as Teacher/);

  const blocked = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', secondParent.cookie)
    .type('form')
    .send({ role: 'assistant', memberId: secondParent.memberId, day: 'monday', _csrf: secondParent.csrfToken });
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
    .send({ role: 'assistant', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /notice=/);
  await db.prepare('DELETE FROM registration_windows').run();
});

// Coverage for the follow-up real request: "under the section for
// registering teacher or class assistant it should list all parent names
// in that family and any students 15 years old or older as eligible to
// register for teacher or class assistant positions" - self-signup used
// to implicitly mean only the logged-in account's own member; now every
// parent plus every 15+ student in the family can be listed and
// registered, the same way "Register your children" already lists every
// child instead of assuming one specific student.
async function createFamilyWithEligibleMembers() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Staff Eligible Family ${familyCounter}`)).lastInsertRowid;
  const parent1Code = await generateMemberCode();
  const parent1Info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Eligible Parent One ${familyCounter}`, parent1Code, parent1Code, familyId);
  const parent2Code = await generateMemberCode();
  const parent2Info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 0, 1)")
    .run(`Eligible Parent Two ${familyCounter}`, parent2Code, parent2Code, familyId);
  const teenBirthday = `${new Date().getFullYear() - 16}-01-01`;
  const teenCode = await generateMemberCode();
  const teenInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, birthday) VALUES (?, ?, ?, 'student', ?, 1, ?)")
    .run(`Eligible Teen ${familyCounter}`, teenCode, teenCode, familyId, teenBirthday);
  const youngBirthday = `${new Date().getFullYear() - 10}-01-01`;
  const youngCode = await generateMemberCode();
  const youngInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, birthday) VALUES (?, ?, ?, 'student', ?, 1, ?)")
    .run(`Ineligible Young Child ${familyCounter}`, youngCode, youngCode, familyId, youngBirthday);

  const email = `staff-eligible-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parent1Info.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return {
    cookie,
    csrfToken: extractCsrf(homePage.text),
    parent1Id: parent1Info.lastInsertRowid,
    parent2Id: parent2Info.lastInsertRowid,
    teenId: teenInfo.lastInsertRowid,
    youngId: youngInfo.lastInsertRowid,
  };
}

test('The Register as Teacher/Assistant section lists every parent and every 15+ student in the family, but not a younger child', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Family Eligibility Class' });
  const family = await createFamilyWithEligibleMembers();

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', family.cookie);
  const parent1 = await db.prepare('SELECT name FROM members WHERE id = ?').get(family.parent1Id);
  const parent2 = await db.prepare('SELECT name FROM members WHERE id = ?').get(family.parent2Id);
  const teen = await db.prepare('SELECT name FROM members WHERE id = ?').get(family.teenId);
  const young = await db.prepare('SELECT name FROM members WHERE id = ?').get(family.youngId);

  // The younger child correctly still appears in "Register your children"
  // above (they're a valid student to register for the class itself) -
  // scope the under-15 exclusion check to just the Teacher/Assistant
  // section, not the whole fragment.
  const staffSectionStart = fragment.text.indexOf('Register as Teacher/Assistant');
  assert.ok(staffSectionStart > -1, 'expected a Register as Teacher/Assistant section');
  const staffSection = fragment.text.slice(staffSectionStart);

  assert.match(staffSection, new RegExp(parent1.name));
  assert.match(staffSection, new RegExp(parent2.name));
  assert.match(staffSection, new RegExp(teen.name));
  assert.doesNotMatch(staffSection, new RegExp(young.name));
});

test('A parent can register ANOTHER eligible family member (a second parent, or a 15+ student) as teacher/assistant, not just themselves', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Register Another Family Member Class' });
  const family = await createFamilyWithEligibleMembers();

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: family.parent2Id, day: 'monday', _csrf: family.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /notice=Signed up as teacher/);
  const parent2Staff = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, family.parent2Id);
  assert.ok(parent2Staff, 'expected a class_staff row for the OTHER parent, registered by the logged-in parent');
  assert.equal(parent2Staff.role, 'teacher');

  const teenRes = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ role: 'assistant', memberId: family.teenId, day: 'monday', _csrf: family.csrfToken });
  assert.match(decodeURIComponent(teenRes.headers.location), /notice=Signed up as assistant/);
  const teenStaff = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, family.teenId);
  assert.ok(teenStaff, 'expected a class_staff row for the 15+ student');
  assert.equal(teenStaff.role, 'assistant');
});

test('A parent cannot register a child under 15, or a member of a DIFFERENT family, as teacher/assistant', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Family Boundary Class' });
  const family = await createFamilyWithEligibleMembers();
  const otherFamily = await createFamilyWithEligibleMembers();

  const underage = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: family.youngId, day: 'monday', _csrf: family.csrfToken });
  assert.match(decodeURIComponent(underage.headers.location), /You can only register eligible members of your own family/);

  const crossFamily = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: otherFamily.parent1Id, day: 'monday', _csrf: family.csrfToken });
  assert.match(decodeURIComponent(crossFamily.headers.location), /You can only register eligible members of your own family/);

  const noStaffRows = await db.prepare('SELECT COUNT(*) AS c FROM class_staff WHERE class_id = ?').get(cls.id);
  assert.equal(noStaffRows.c, 0);
});

// A real bug report: "it's not showing parent names to register as
// teacher or assistant" - traced to staffEligibleFamilyMembers requiring
// the account's own member to have a family_id set, when members.
// family_id is nullable and gets cleared (ON DELETE SET NULL) if the
// family row it pointed at is ever deleted or merged away, without
// touching the member's own active status or portal account. A parent
// with no children (the only prior caller of parentsForAccount/
// childrenForAccount, both of which also bail out to [] on no family_id)
// who got orphaned that way saw NOBODY listed, not even themselves -
// even though self-signup never needed a family_id at all before this
// feature existed.
async function createParentWithNoFamily() {
  familyCounter += 1;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', NULL, 1, 1)")
    .run(`Orphaned Parent ${familyCounter}`, code, code);
  const email = `orphaned-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text), memberId: memberInfo.lastInsertRowid };
}

test('A parent with no family_id (orphaned by a deleted/merged family) still sees themselves in the Register as Teacher/Assistant section and can self-register', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Orphaned Parent Class' });
  const parent = await createParentWithNoFamily();

  const fragment = await request(app).get(`/parent/classes/${cls.id}/fragment?day=monday`).set('Cookie', parent.cookie);
  assert.equal(fragment.status, 200);
  const parentMember = await db.prepare('SELECT name FROM members WHERE id = ?').get(parent.memberId);
  assert.match(fragment.text, new RegExp(`<span class="parent-class-child-name-text">${parentMember.name}</span>`));
  assert.doesNotMatch(fragment.text, /No eligible family members/);

  const joined = await request(app)
    .post(`/parent/classes/${cls.id}/join`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ role: 'teacher', memberId: parent.memberId, day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(joined.headers.location), /notice=Signed up as teacher/);
});

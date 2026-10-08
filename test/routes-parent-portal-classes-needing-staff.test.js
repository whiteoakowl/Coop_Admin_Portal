// Coverage for a real request: "Parent portal, class registration page.
// Add a button at the top that says, classes needing a teacher or
// assistant... list view by hour... class name and next to it how many
// teachers/assistants it needs... click on the class [goes] to the class
// registration for that class... once filled it will not appear...
// reappear if someone withdraws... dropdown filter for semester/day."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-classes-needing-staff-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-classes-needing-staff-test-uploads-${process.pid}`);
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

async function createClass(admin, overrides) {
  const className = (overrides && overrides.className) || 'Needing Staff Test Class';
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
      allowParentRegister: '1',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await db.prepare('UPDATE classes SET registration_open = 1, allow_parent_register = 1, allow_cancel = 1 WHERE id = ?').run(cls.id);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

let memberCounter = 0;
async function createActiveMember(name) {
  memberCounter += 1;
  const code = await generateMemberCode();
  const info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)")
    .run(`${name} ${memberCounter}`, code, code);
  return info.lastInsertRowid;
}

async function addStaff(classId, memberId, role) {
  await db.prepare('INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)').run(classId, memberId, role);
}

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Needing Staff Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Needing Staff Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const email = `needing-staff-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text) };
}

test('Class Registration page shows a "Classes Needing a Teacher or Assistant" button linking to the needing-staff list', async () => {
  const parent = await createParentWithChild();
  const page = await request(app).get('/parent/classes?day=monday').set('Cookie', parent.cookie);
  assert.match(page.text, /<a class="roster-action-btn" href="\/parent\/classes\/needing-staff\?day=monday">Classes Needing a Teacher or Assistant<\/a>/);
});

test('A class short a teacher and/or assistant shows up on the needing-staff list, grouped by hour, with counts; a fully-staffed class does not', async () => {
  const admin = await loginAsAdmin();
  const short = await createClass(admin, { className: 'Short Staffed Class' });
  await db.prepare('UPDATE classes SET teacher_slots = 1, assistant_slots = 2 WHERE id = ?').run(short.id);
  const teacherId = await createActiveMember('Needs Teacher');
  // One assistant signed up out of two needed - still short one.
  await addStaff(short.id, teacherId, 'assistant');

  const full = await createClass(admin, { className: 'Fully Staffed Class', hourPosition: '2' });
  await db.prepare('UPDATE classes SET teacher_slots = 1, assistant_slots = 1 WHERE id = ?').run(full.id);
  const fullTeacherId = await createActiveMember('Has Teacher');
  const fullAssistantId = await createActiveMember('Has Assistant');
  await addStaff(full.id, fullTeacherId, 'teacher');
  await addStaff(full.id, fullAssistantId, 'assistant');

  const parent = await createParentWithChild();
  const page = await request(app).get('/parent/classes/needing-staff?day=monday').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Short Staffed Class/);
  assert.match(page.text, /Teacher needed/);
  assert.match(page.text, /Assistant needed/);
  assert.doesNotMatch(page.text, /Fully Staffed Class/);
  // Clicking a row goes straight to that class's own registration card.
  assert.match(page.text, new RegExp(`href="/parent/classes\\?day=monday&openClass=${short.id}"`));
});

test('A class with both roles filled drops off the list; it reappears once a withdrawal drops a count back below its cap', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Reappearing Class', hourPosition: '3' });
  await db.prepare('UPDATE classes SET teacher_slots = 1, assistant_slots = 0 WHERE id = ?').run(cls.id);
  const teacherId = await createActiveMember('Soon Withdrawing Teacher');
  await addStaff(cls.id, teacherId, 'teacher');

  const parent = await createParentWithChild();
  const beforeWithdraw = await request(app).get('/parent/classes/needing-staff?day=monday').set('Cookie', parent.cookie);
  assert.doesNotMatch(beforeWithdraw.text, /Reappearing Class/);

  await db.prepare('DELETE FROM class_staff WHERE class_id = ? AND member_id = ?').run(cls.id, teacherId);

  const afterWithdraw = await request(app).get('/parent/classes/needing-staff?day=monday').set('Cookie', parent.cookie);
  assert.match(afterWithdraw.text, /Reappearing Class/);
  assert.match(afterWithdraw.text, /Teacher needed/);
});

test('needing-staff page has a Semester/Day combo picker and a back link to Class Registration', async () => {
  const parent = await createParentWithChild();
  const page = await request(app).get('/parent/classes/needing-staff?day=monday').set('Cookie', parent.cookie);
  assert.match(page.text, /schedule-combo-picker/);
  assert.match(page.text, /<a href="\/parent\/classes\?day=monday">&larr; Class Registration<\/a>/);
});

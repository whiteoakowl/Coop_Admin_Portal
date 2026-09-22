// A real request: "main admin, classes, settings. Add registration
// schedule. Be able to control who can signup on each schedule grid
// monday/Wednesday. Date, time and section and open for teacher or
// assistant registration." Follow-up questions confirmed: (1) this
// should gate everyone who registers for a class (parents/students/
// teachers), not just teacher/assistant; (2) "section" means the
// existing Sections feature; (3) class settings always live under Co-op
// Admin's own Classes > Settings tab, not a separate Main Admin page -
// so this extends the existing (previously orphaned - zero inbound nav
// links) registration_windows feature with day + section scoping, hosts
// it on /admin/schedule?tab=settings, and wires it into real enforcement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-schedule-registration-schedule-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-schedule-registration-schedule-test-uploads-${process.pid}`);
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

async function clearWindows() {
  await db.prepare('DELETE FROM registration_windows').run();
}

async function createSection(name) {
  return (await db.prepare('INSERT INTO sections (name) VALUES (?)').run(name)).lastInsertRowid;
}

let classCounter = 0;
async function createClass(admin, overrides) {
  classCounter += 1;
  const className = (overrides && overrides.className) || `Schedule Test Class ${classCounter}`;
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
      allowStudentRegister: '1',
      allowTeacherRegister: '1',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await db.prepare('UPDATE classes SET registration_open = 1, allow_parent_register = 1, allow_student_register = 1, allow_teacher_register = 1 WHERE id = ?').run(cls.id);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Schedule Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Schedule Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Schedule Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `schedule-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text), childId: childInfo.lastInsertRowid };
}

let teacherCounter = 0;
async function createTeacherAccount() {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1)")
    .run(`Schedule Teacher ${teacherCounter}`, code, code);
  const email = `schedule-teacher${teacherCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, teacherRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/teacher').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(homePage.text) };
}

test('Classes > Settings tab: Add a Window form has Schedule Grid and Section fields; a day+section-scoped window shows in Current Windows', async () => {
  await clearWindows();
  const admin = await loginAsAdmin();
  const sectionId = await createSection('Teen Co-op');

  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Registration Schedule/);
  assert.match(page.text, /<select name="day">/);
  assert.match(page.text, /<select name="sectionId">/);
  assert.match(page.text, /Teen Co-op/);

  await request(app)
    .post('/admin/schedule/registration-windows')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Monday Teen Window', day: 'monday', sectionId: String(sectionId), opensAt: '2020-01-01T00:00', _csrf: admin.csrfToken });

  const after = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.match(after.text, /Monday Teen Window/);
  assert.match(after.text, />Monday</);
  assert.match(after.text, /Teen Co-op/);
});

test('Deleting a registration window removes it from Current Windows', async () => {
  await clearWindows();
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/registration-windows')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'To Delete', opensAt: '2020-01-01T00:00', _csrf: admin.csrfToken });
  const win = await db.prepare("SELECT id FROM registration_windows WHERE label = 'To Delete'").get();

  await request(app).post(`/admin/schedule/registration-windows/${win.id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  const after = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.doesNotMatch(after.text, /To Delete/);
});

test('A day-scoped registration window only gates registration for classes on that schedule grid', async () => {
  await clearWindows();
  const { createWindow } = require('../utils/registrationWindows');
  await createWindow({ label: 'Monday Only', roleKey: null, opensAt: '2020-01-01 00:00:00', closesAt: null, day: 'monday' });

  const admin = await loginAsAdmin();
  const mondayClass = await createClass(admin, { day: 'monday', className: 'Monday Gated Class' });
  const wednesdayClass = await createClass(admin, { day: 'wednesday', className: 'Wednesday Gated Class' });

  const parent = await createParentWithChild();
  const mondayReg = await request(app)
    .post(`/parent/classes/${mondayClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  assert.match(mondayReg.headers.location, /notice=/);

  const wednesdayReg = await request(app)
    .post(`/parent/classes/${wednesdayClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'wednesday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(wednesdayReg.headers.location), /Registration is not open for your account yet/);
});

test('A section-scoped registration window only gates registration for classes restricted to that section', async () => {
  await clearWindows();
  const sectionId = await createSection('Section-Gated Group');
  const { createWindow } = require('../utils/registrationWindows');
  await createWindow({ label: 'Section Only', roleKey: null, opensAt: '2020-01-01 00:00:00', closesAt: null, sectionId });

  const admin = await loginAsAdmin();
  const openClass = await createClass(admin, { className: 'Unrestricted Class' });
  const gatedClass = await createClass(admin, { className: 'Section Restricted Class' });
  await db.prepare('INSERT INTO class_sections (class_id, section_id) VALUES (?, ?)').run(gatedClass.id, sectionId);

  const parent = await createParentWithChild();
  const openReg = await request(app)
    .post(`/parent/classes/${openClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(openReg.headers.location), /Registration is not open for your account yet/);

  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(parent.childId, sectionId);
  const gatedReg = await request(app)
    .post(`/parent/classes/${gatedClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  assert.match(gatedReg.headers.location, /notice=/);
});

test('Teacher Portal self-signup is also gated by a registration window (previously had zero enforcement)', async () => {
  await clearWindows();
  const { createWindow } = require('../utils/registrationWindows');
  await createWindow({ label: 'Not Open Yet', roleKey: 'teacher', opensAt: '2099-01-01 00:00:00', closesAt: null });

  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Teacher Gated Class' });
  const teacher = await createTeacherAccount();

  const blocked = await request(app)
    .post(`/teacher/classes/${cls.id}/join`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ role: 'teacher', _csrf: teacher.csrfToken });
  assert.match(decodeURIComponent(blocked.headers.location), /Registration is not open for your account yet/);

  await clearWindows();
  const allowed = await request(app)
    .post(`/teacher/classes/${cls.id}/join`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ role: 'teacher', _csrf: teacher.csrfToken });
  assert.match(decodeURIComponent(allowed.headers.location), /notice=/);
});

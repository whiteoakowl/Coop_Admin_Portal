// A real request: "main admin, classes, settings. Add registration
// schedule. Be able to control who can signup on each schedule grid
// monday/Wednesday. Date, time and section and open for teacher or
// assistant registration." Follow-up questions confirmed: (1) this
// should gate everyone who registers for a class (parents/students/
// teachers), not just teacher/assistant; (2) "section" means the
// existing Sections feature; (3) class settings always live under Co-op
// Admin's own Classes > Settings tab, not a separate Main Admin page -
// so this extends the existing (previously orphaned - zero inbound nav
// links) registration_windows feature with schedule-grid + section
// scoping, hosts it on /admin/schedule?tab=settings, and wires it into
// real enforcement. A later request replaced the generic role_key "Open
// For" dropdown with 4 specific action-type checkboxes (parents
// registering to teach/assist, parents registering their own student,
// students registering themselves), let Section be multi-selected, and
// swapped the day-only Schedule Grid picker for the real class_schedules
// catalog (its own admin-given titles) - see utils/registrationWindows.js's
// own header comment.
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

async function classScheduleIdForDay(day) {
  const row = await db.prepare('SELECT id FROM class_schedules WHERE day_of_week = ? AND semester_id IS NULL').get(day);
  return row.id;
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

test('Classes > Settings tab: Add a Window form has Schedule Grid, Section, and action-type fields; a schedule-grid+section-scoped window shows in Current Windows', async () => {
  await clearWindows();
  const admin = await loginAsAdmin();
  const sectionId = await createSection('Teen Co-op');
  const mondayScheduleId = await classScheduleIdForDay('monday');

  // The Registration Schedule section moved under Settings > Semester,
  // dropping its own separate sub-tab - a real request: "this settings
  // is done through the semester tab." An old bookmark still redirects
  // there instead of 404ing/landing on General.
  const oldLink = await request(app).get('/admin/schedule?tab=settings&settingsTab=registration').set('Cookie', admin.cookie);
  assert.equal(oldLink.status, 302);
  assert.match(oldLink.headers.location, /settingsTab=registration-schedule/);

  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=registration-schedule').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Registration Schedule/);
  // "Add a Window" is now a button that opens a popup, not an always-
  // visible inline form.
  assert.match(page.text, /id="add-window-dialog"/);
  assert.match(page.text, /\+ Add a Window/);
  assert.match(page.text, /<select name="classScheduleId">/);
  assert.match(page.text, /name="sectionIds" value="[^"]*"/);
  assert.match(page.text, /name="actionTypes" value="parent_teacher"/);
  assert.match(page.text, /name="actionTypes" value="parent_assistant"/);
  assert.match(page.text, /name="actionTypes" value="parent_register_student"/);
  assert.match(page.text, /name="actionTypes" value="student_register_self"/);
  assert.match(page.text, /Teen Co-op/);
  assert.match(page.text, />Monday</);

  await request(app)
    .post('/admin/schedule/registration-windows')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      label: 'Monday Teen Window',
      classScheduleId: String(mondayScheduleId),
      sectionIds: String(sectionId),
      actionTypes: 'parent_register_student',
      opensAt: '2020-01-01T00:00',
      _csrf: admin.csrfToken,
    });

  const after = await request(app).get('/admin/schedule?tab=settings&settingsTab=registration-schedule').set('Cookie', admin.cookie);
  assert.match(after.text, /Monday Teen Window/);
  assert.match(after.text, />Monday</);
  assert.match(after.text, /Teen Co-op/);
  assert.match(after.text, /Parent: Register Student/);

  // An Edit button next to Delete opens a pre-filled popup for that window.
  const win = await db.prepare("SELECT id FROM registration_windows WHERE label = 'Monday Teen Window'").get();
  assert.match(after.text, new RegExp(`id="edit-window-dialog-${win.id}"`));
  assert.match(after.text, new RegExp(`action="/admin/schedule/registration-windows/${win.id}/update"`));
  const editDialog = /<dialog id="edit-window-dialog-\d+"[^]*?<\/dialog>/.exec(after.text)[0];
  assert.match(editDialog, /value="Monday Teen Window"/);
  assert.match(editDialog, new RegExp(`name="sectionIds" value="${sectionId}" checked`));
  assert.match(editDialog, /name="actionTypes" value="parent_register_student" checked/);
});

test('Editing a registration window updates its fields', async () => {
  await clearWindows();
  const admin = await loginAsAdmin();
  const wednesdayScheduleId = await classScheduleIdForDay('wednesday');
  await request(app)
    .post('/admin/schedule/registration-windows')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Editable Window', opensAt: '2020-01-01T00:00', _csrf: admin.csrfToken });
  const win = await db.prepare("SELECT id FROM registration_windows WHERE label = 'Editable Window'").get();

  await request(app)
    .post(`/admin/schedule/registration-windows/${win.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      label: 'Renamed Window',
      classScheduleId: String(wednesdayScheduleId),
      actionTypes: 'student_register_self',
      opensAt: '2021-02-02T00:00',
      _csrf: admin.csrfToken,
    });

  const after = await request(app).get('/admin/schedule?tab=settings&settingsTab=registration-schedule').set('Cookie', admin.cookie);
  assert.match(after.text, /Renamed Window/);
  assert.doesNotMatch(after.text, /Editable Window</);
  assert.match(after.text, /Student: Register Self/);

  const updated = await db.prepare('SELECT * FROM registration_windows WHERE id = ?').get(win.id);
  assert.equal(updated.class_schedule_id, wednesdayScheduleId);
  assert.equal(updated.open_for_student_register_self, true);
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
  const after = await request(app).get('/admin/schedule?tab=settings&settingsTab=registration-schedule').set('Cookie', admin.cookie);
  assert.doesNotMatch(after.text, /To Delete/);
});

test('A schedule-grid-scoped registration window only gates registration for classes on that schedule grid', async () => {
  await clearWindows();
  const { createWindow } = require('../utils/registrationWindows');
  const mondayScheduleId = await classScheduleIdForDay('monday');
  await createWindow({ label: 'Monday Only', opensAt: '2020-01-01 00:00:00', closesAt: null, classScheduleId: mondayScheduleId });

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
  await createWindow({ label: 'Section Only', opensAt: '2020-01-01 00:00:00', closesAt: null, sectionIds: [sectionId] });

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
  await createWindow({ label: 'Not Open Yet', opensAt: '2099-01-01 00:00:00', closesAt: null, actionTypes: ['parent_teacher'] });

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

// A real bug report: a co-op checked only "Parents can register for
// teaching positions" and "...assistant positions" on their one
// Registration Window (meant as an early-access window for staff), and
// it silently closed ordinary parent-student registration site-wide too
// - every parent got "Registration isn't open for your account yet"
// with no "it opens..." date, since nothing anywhere had ever opened a
// window for that action. Schedule-grid/section scoping both already
// follow "empty/unmatched = doesn't apply to this one, keep checking
// other windows" (see the section- and schedule-grid-scoped tests
// above); action-type scoping now follows the same idea one level up -
// each of the 4 checkboxes gates ONLY the action(s) it's checked for,
// never any other, and multiple boxes on one window still combine
// (checking 2 means that window covers both of those 2, same as before).
test('A window scoped to only "parent_teacher"/"parent_assistant" does not block parent-student or student-self registration, which no window has ever checked (each action-type checkbox works independently)', async () => {
  await clearWindows();
  const { createWindow } = require('../utils/registrationWindows');
  await createWindow({ label: 'Staff Early Access', opensAt: '2020-01-01 00:00:00', closesAt: null, actionTypes: ['parent_teacher', 'parent_assistant'] });

  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Independent Action Types Class' });
  const teacher = await createTeacherAccount();

  const teacherAllowed = await request(app)
    .post(`/teacher/classes/${cls.id}/join`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ role: 'teacher', _csrf: teacher.csrfToken });
  assert.match(decodeURIComponent(teacherAllowed.headers.location), /notice=/);

  await db.prepare('DELETE FROM class_staff WHERE class_id = ?').run(cls.id);
  const assistantAllowed = await request(app)
    .post(`/teacher/classes/${cls.id}/join`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ role: 'assistant', _csrf: teacher.csrfToken });
  assert.match(decodeURIComponent(assistantAllowed.headers.location), /notice=/);

  // The real bug: a parent registering their own child, an action this
  // window never checked, must stay open exactly as if no window
  // existed at all - not get swept up as "closed by default" just
  // because a DIFFERENT action now has its own window.
  const parent = await createParentWithChild();
  const parentReg = await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  assert.match(parentReg.headers.location, /notice=/);
});

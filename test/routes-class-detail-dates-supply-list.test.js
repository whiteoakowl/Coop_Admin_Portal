// Coverage for a real request: "Parent and student portal. On classroom
// dashboard when you click on a Class card it take you to that class.
// Details should have teachers, assistants, room number, start and end
// dates, start and end time, day of the week, class description, supply
// list. Lessons, should be able to click on the lessons and complete
// them." Lesson click-through/completion was already built (a Details
// tab with the rest of these fields was not) - this covers the new
// start_date/end_date/supply_list columns end to end: the Co-op Admin
// edit form that sets them, and both Parent Portal's and Student
// Portal's own class detail "Details" tab that now shows them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-detail-dates-supply-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-detail-dates-supply-test-uploads-${process.pid}`);
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
  const className = (overrides && overrides.className) || 'Dates Supply Class';
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
  return db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
}

test('Co-op Admin Class Details form saves and pre-fills Start Date/End Date/Supply List', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Save Dates Class' });

  const editPage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(editPage.text);

  const save = await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      className: 'Save Dates Class',
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      startDate: '2026-09-01',
      endDate: '2026-12-15',
      supplyList: 'Pencils, glue sticks, a folder',
      _csrf: csrf,
    });
  assert.equal(save.status, 302);

  const row = await db.prepare('SELECT start_date, end_date, supply_list FROM classes WHERE id = ?').get(cls.id);
  assert.equal(row.start_date, '2026-09-01');
  assert.equal(row.end_date, '2026-12-15');
  assert.equal(row.supply_list, 'Pencils, glue sticks, a folder');

  const after = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  assert.match(after.text, /name="startDate" value="2026-09-01"/);
  assert.match(after.text, /name="endDate" value="2026-12-15"/);
  assert.match(after.text, />Pencils, glue sticks, a folder<\/textarea>/);
});

let familyCounter = 0;
async function createParentWithChildInClass(admin, cls) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Detail Dates Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Detail Dates Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Detail Dates Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `detail-dates-parent${familyCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, childInfo.lastInsertRowid);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { cookie: loginRes.headers['set-cookie'], childId: childInfo.lastInsertRowid };
}

test('Parent Portal class detail Details tab shows Start Date, End Date, and Supply List', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Parent Detail Class' });
  await db.prepare('UPDATE classes SET start_date = ?, end_date = ?, supply_list = ? WHERE id = ?').run('2026-09-01', '2026-12-15', 'Notebook and pencils', cls.id);

  const parent = await createParentWithChildInClass(admin, cls);
  const page = await request(app).get(`/parent/classes/dashboard/${cls.id}?studentId=${parent.childId}&tab=details`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<strong>Start Date:<\/strong> 2026-09-01/);
  assert.match(page.text, /<strong>End Date:<\/strong> 2026-12-15/);
  assert.match(page.text, /Notebook and pencils/);
});

test('Student Portal class detail defaults to a Details tab showing the same fields', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Student Detail Class' });
  await db.prepare('UPDATE classes SET start_date = ?, end_date = ?, supply_list = ? WHERE id = ?').run('2026-09-01', '2026-12-15', 'A backpack', cls.id);

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Student Detail Family')).lastInsertRowid;
  const code = await generateMemberCode();
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Student Detail Kid', ?, ?, 'student', ?, 1)")
    .run(code, code, familyId);
  const email = 'student-detail-kid@example.com';
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(studentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, studentRole.id);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, studentInfo.lastInsertRowid);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const page = await request(app).get(`/student/classes/${cls.id}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="view-tab active" href="\?tab=details">Details/);
  assert.match(page.text, /<strong>Start Date:<\/strong> 2026-09-01/);
  assert.match(page.text, /<strong>End Date:<\/strong> 2026-12-15/);
  assert.match(page.text, /A backpack/);

  const assignmentsTab = await request(app).get(`/student/classes/${cls.id}?tab=assignments`).set('Cookie', cookie);
  assert.equal(assignmentsTab.status, 200);
  assert.match(assignmentsTab.text, /class="view-tab active" href="\?tab=assignments">Assignments/);
});

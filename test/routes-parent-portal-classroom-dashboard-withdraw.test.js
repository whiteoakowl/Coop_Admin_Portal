// Coverage for a real request: "On classroom dashboard, all classes
// should have a delete button and view class button on each row to the
// right... If they confirm Cancel class, this will automatically send a
// notification to request a name tag reprint. Remove view/cancel class
// page. You can now cancel the class on the classroom dashboard with the
// new feature described above. Student portal does not have delete
// class button, only view class button. Only parent portal or admins can
// cancel classes, not students."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classroom-dashboard-withdraw-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classroom-dashboard-withdraw-test-uploads-${process.pid}`);
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

let seedCounter = 0;
async function createClass(admin, overrides) {
  seedCounter += 1;
  const className = (overrides && overrides.className) || `Withdraw Test Class ${seedCounter}`;
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

async function createParentWithChild() {
  seedCounter += 1;
  const n = seedCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Withdraw Family ${n}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Withdraw Parent ${n}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Withdraw Child ${n}`, childCode, childCode, familyId);
  const email = `withdraw-parent-${n}@example.com`;
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

test('the View/Cancel Classes page no longer exists', async () => {
  const parent = await createParentWithChild();
  const res = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  assert.equal(res.status, 404);
});

test('Classroom Dashboard: each enrolled class card has a View Class button and a Delete button', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin);
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get(`/parent/classes/dashboard?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, new RegExp(`href="/parent/classes/dashboard/${cls.id}\\?studentId=${parent.childId}">View Class</a>`));
  assert.match(dashboard.text, new RegExp(`data-withdraw-class-url="/parent/classes/${cls.id}/unregister"`));
  assert.match(dashboard.text, new RegExp(`data-withdraw-student-id="${parent.childId}"`));
  assert.match(dashboard.text, />Delete<\/button>/);
});

test('Classroom Dashboard withdraw JS carries the exact confirmation wording and Cancel/Confirm buttons', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'classroom-dashboard-withdraw.js'), 'utf8');
  assert.match(js, /Are you sure you want to withdraw from this class\? This action can't be reversed and a waitlisted student may take your spot\./);
  assert.match(js, /yesLabel: 'Confirm'/);
  assert.match(js, /cancelLabel: 'Cancel'/);
});

test('Cancelling a class registration automatically files a name tag reprint request', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Name Tag Trigger Class' });
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get(`/parent/classes/dashboard?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  const csrf = extractCsrf(dashboard.text);

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', parent.cookie)
    .set('X-Requested-With', 'fetch')
    .set('X-CSRF-Token', csrf)
    .type('form')
    .send({ studentId: String(parent.childId) });
  assert.deepEqual(res.body, { ok: true });

  const request_ = await db
    .prepare("SELECT * FROM name_tag_requests WHERE member_id = ? AND request_type = 'schedule_change' ORDER BY id DESC LIMIT 1")
    .get(parent.childId);
  assert.ok(request_, 'expected an automatic name tag reprint request');
  assert.equal(request_.day, 'monday');
  assert.match(request_.description, /Name Tag Trigger Class/);
});

test('the class card disappears from the enrolled child\'s own Classroom Dashboard view once cancelled', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Should Disappear Class' });
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get(`/parent/classes/dashboard?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.match(dashboard.text, /Should Disappear Class/);
  const csrf = extractCsrf(dashboard.text);

  await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', parent.cookie)
    .set('X-Requested-With', 'fetch')
    .set('X-CSRF-Token', csrf)
    .type('form')
    .send({ studentId: String(parent.childId) });

  const after = await request(app).get(`/parent/classes/dashboard?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(after.text, /Should Disappear Class/);
});

// A real request: "Student portal does not have delete class button, only
// view class button." Student Portal's own class list ("My Classes",
// views/student-classes.ejs) never uses the Classroom Dashboard's card
// partial at all, so it has no Delete-with-confirmation button to begin
// with - only its own pre-existing self-registered-class Cancel action
// (a distinct, unrelated feature this request doesn't touch).
test('Student Portal My Classes page has no Classroom-Dashboard-style withdraw button', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Student View Only Class' });
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const studentEmail = `student-view-only-${seedCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parent.childId, studentEmail, hashPassword('testpassword123'));
  const studentAcct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(studentEmail);
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(studentAcct.id, studentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email: studentEmail, password: 'testpassword123', next: '/student' });
  const studentCookie = loginRes.headers['set-cookie'];

  const page = await request(app).get('/student/classes').set('Cookie', studentCookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Student View Only Class/);
  assert.doesNotMatch(page.text, /data-withdraw-class-btn/);
});

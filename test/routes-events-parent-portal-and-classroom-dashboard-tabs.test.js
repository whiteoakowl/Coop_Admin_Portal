// Two bundled real requests:
// 1. "On the parent portal when you click on browse events it switches
//    to student portal. It should stay in parent portal. The event
//    calendar should show regardless if there are events on the
//    calendar or not. On mobile, submit an event and print buttons
//    should be on the same row. Delete description on page. Browse
//    events subpage should be titled Event Calendar."
// 2. "Parent portal, co-op classes. Class dashboard should be called
//    Classroom Dashboard. When you click on the class you see tabs. The
//    detail tab should include the teacher(s) names, description for
//    the class and cost per student. The description on the class page
//    should be on the details tab page. Grades should be the last tab."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-parent-classroom-tabs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-parent-classroom-tabs-test-uploads-${process.pid}`);
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

let familyCounter = 0;
async function createParentAndStudentDualRoleAccount() {
  familyCounter += 1;
  const n = familyCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Dual Role Family ${n}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Dual Role Parent ${n}`, parentCode, parentCode, familyId);
  const email = `dual-role-parent-${n}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  // Same account carries BOTH roles - the exact scenario the bug report
  // describes ("switches to student portal" implies the account is not
  // parent-only).
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, studentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return loginRes.headers['set-cookie'];
}

test('a dual student+parent account clicking Events from the Parent Portal nav stays in Parent Portal, not Student', async () => {
  const cookie = await createParentAndStudentDualRoleAccount();

  // Confirm the Parent Portal nav itself links with ?portal=parent. A
  // later real request ("event calendar should land on calendar view,
  // not list view") added view=calendar to this same link.
  const home = await request(app).get('/parent').set('Cookie', cookie);
  assert.match(home.text, /href="\/events\?view=calendar&(?:amp;)?portal=parent"/);

  // Following that exact link renders the Parent Portal shell, not Student.
  const events = await request(app).get('/events?view=calendar&portal=parent').set('Cookie', cookie);
  assert.equal(events.status, 200);
  assert.match(events.text, /Parent Portal/);
  assert.match(events.text, /href="\/parent\/events">My Event Registrations<\/a>/);
  assert.doesNotMatch(events.text, /href="\/student\/events">My Event Registrations<\/a>/);
});

test('a dual-role account hitting /events with no portal param at all still falls back to the old Student-first guess', async () => {
  const cookie = await createParentAndStudentDualRoleAccount();
  const events = await request(app).get('/events').set('Cookie', cookie);
  assert.equal(events.status, 200);
  assert.match(events.text, /Student Portal/);
});

test('the Events calendar always renders the grid, even with zero published events', async () => {
  const cookie = await createParentAndStudentDualRoleAccount();
  const res = await request(app).get('/events?view=calendar&portal=parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-table condensed-table event-calendar-table"/);
  assert.doesNotMatch(res.text, /No upcoming events right now/);
});

test('the Events page description text is gone, and the Parent Portal Events subpage is titled Event Calendar', async () => {
  const cookie = await createParentAndStudentDualRoleAccount();
  const res = await request(app).get('/events?view=calendar&portal=parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Upcoming co-op events, fundraisers/);
  assert.match(res.text, /<h1>Event Calendar<\/h1>/);
  assert.match(res.text, /class="view-tab" href="\/events\?view=calendar&(?:amp;)?portal=parent">Event Calendar<\/a>/);
});

test('mobile: Print and + Submit an Event share one row, not split across two', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.roster-btn-row > \.class-schedule-view-toggle\s*\{\s*grid-column:\s*1\s*\/\s*-1;/);
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createClassroomTabsClass(admin) {
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      className: 'Classroom Tabs Class',
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      allowParentRegister: '1',
      _csrf: admin.csrfToken,
    });
  const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Classroom Tabs Class'").get();
  await db
    .prepare("UPDATE classes SET registration_open = 1, allow_parent_register = 1, allow_cancel = 1, description = 'A fun class about fun things.', price_cents = 2500 WHERE id = ?")
    .run(cls.id);
  const teacherCode = await generateMemberCode();
  const teacherInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Classroom Tabs Teacher', ?, ?, 'parent', 1)")
    .run(teacherCode, teacherCode);
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(cls.id, teacherInfo.lastInsertRowid);
  return db.prepare('SELECT * FROM classes WHERE id = ?').get(cls.id);
}

async function createParentWithChildFor(cls) {
  familyCounter += 1;
  const n = familyCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Classroom Tabs Family ${n}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Classroom Tabs Parent ${n}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Classroom Tabs Child ${n}`, childCode, childCode, familyId);
  const email = `classroom-tabs-parent-${n}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const homePage = await request(app).get('/parent').set('Cookie', cookie);
  const csrfToken = extractCsrf(homePage.text);
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', cookie)
    .type('form')
    .send({ studentId: String(childInfo.lastInsertRowid), day: 'monday', _csrf: csrfToken });
  return { cookie, childId: childInfo.lastInsertRowid };
}

test('Parent Portal nav calls it Classroom Dashboard, not Class Dashboard', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClassroomTabsClass(admin);
  const parent = await createParentWithChildFor(cls);
  const home = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(home.text, /Classroom Dashboard/);
  assert.doesNotMatch(home.text, /class="view-tab" href="\/parent\/classes\/dashboard">Class Dashboard</);

  const picker = await request(app).get('/parent/classes/dashboard').set('Cookie', parent.cookie);
  assert.match(picker.text, /<h1>Classroom Dashboard<\/h1>/);
});

test('Classroom Dashboard Details tab has Teacher(s), Description, and Cost per Student; Grades is the last tab', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClassroomTabsClass(admin);
  const parent = await createParentWithChildFor(cls);

  const detail = await request(app).get(`/parent/classes/dashboard/${cls.id}?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /<strong>Teacher\(s\):<\/strong> Classroom Tabs Teacher/);
  assert.match(detail.text, /<strong>Description:<\/strong>/);
  assert.match(detail.text, /A fun class about fun things\./);
  assert.match(detail.text, /<strong>Cost per Student:<\/strong> \$25\.00/);

  // Tab order: Details, Assignments, Lessons, Attendance, then Grades last.
  const tabOrder = ['Details', 'Assignments', 'Lessons', 'Attendance', 'Grades'];
  const positions = tabOrder.map((label) => {
    const idx = detail.text.indexOf(`>${label}</a>`);
    assert.ok(idx !== -1, `expected to find tab "${label}"`);
    return idx;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `expected "${tabOrder[i]}" to come after "${tabOrder[i - 1]}"`);
  }
});

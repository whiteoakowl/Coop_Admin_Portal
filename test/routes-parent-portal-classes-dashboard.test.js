// Coverage for a real request: "Parent portal, classes, manage classes.
// Should show lists of classes by member of that family in list view.
// Trash button at the end of the row of each class, red. When they click
// trash they are removed from that class roster and the class instantly
// deletes from their schedule without refreshing the page. Print, export,
// print name tag buttons at the top of the page. Be able to click on
// each class and go to that classes dashboard... Parent portal, classes,
// subpage manage classes should say view/cancel classes. Add subpage
// class dashboard. Class dashboard is where you can view all of the
// class information, assignments, grades, lessons etc... Parent portal
// there is a dropdown menu at the top of classroom dashboard with each
// family member to choose view. Classroom dashboard homepage for each
// member shows class cards. Monday 1st row, Wednesday 2nd row."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-classes-dashboard-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-classes-dashboard-test-uploads-${process.pid}`);
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
const { createAssignment, saveGrade } = require('../utils/academics');

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
  const className = (overrides && overrides.className) || 'Dashboard Test Class';
  const day = (overrides && overrides.day) || 'monday';
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day,
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

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Dashboard Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Dashboard Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Dashboard Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `dashboard-parent${familyCounter}@example.com`;
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

test('View/Cancel Classes: list view groups by family member, and toolbar has Print/Export/Print Name Tag', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Toolbar Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const manage = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /manage-classes-group-header">Dashboard Child \d+</);
  assert.match(manage.text, /href="\/parent\/classes\/manage\/print"/);
  assert.match(manage.text, /href="\/parent\/classes\/manage\/export\.csv"/);
  assert.match(manage.text, /href="\/parent\/name-tags">Print Name Tag/);
});

// A real request: "viewing class schedule for family or person student,
// classes should be categorized as Monday or Wednesday and in time
// order" - within one child's own block, entries used to sort
// alphabetically by class name; now Monday sorts before Wednesday, and
// within a day by hour_position (actual time slot).
test('View/Cancel Classes: within one child\'s block, entries sort Monday-then-Wednesday and by time, not alphabetically', async () => {
  const admin = await loginAsAdmin();
  const wednesdayClass = await createClass(admin, { className: 'A Wednesday Entry', day: 'wednesday', hourPosition: '1' });
  const mondayLater = await createClass(admin, { className: 'B Monday Later', day: 'monday', hourPosition: '2' });
  const mondayEarlier = await createClass(admin, { className: 'C Monday Earlier', day: 'monday', hourPosition: '1' });
  const parent = await createParentWithChild();

  for (const cls of [wednesdayClass, mondayLater, mondayEarlier]) {
    await request(app)
      .post(`/parent/classes/${cls.id}/register`)
      .set('Cookie', parent.cookie)
      .type('form')
      .send({ studentId: String(parent.childId), day: cls.day, _csrf: parent.csrfToken });
  }

  const manage = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  const iEarlier = manage.text.indexOf('C Monday Earlier');
  const iLater = manage.text.indexOf('B Monday Later');
  const iWed = manage.text.indexOf('A Wednesday Entry');
  assert.ok(iEarlier > 0 && iLater > 0 && iWed > 0, 'all three classes should render');
  assert.ok(iEarlier < iLater, 'the earlier Monday hour_position should render before the later one, despite its name sorting after alphabetically');
  assert.ok(iLater < iWed, 'Monday entries should render before Wednesday entries, despite the Wednesday class name sorting first alphabetically');
});

test('View/Cancel Classes: fetch-style cancel (X-Requested-With) returns JSON instead of redirecting, and actually cancels', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Instant Delete Class' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const manage = await request(app).get('/parent/classes/manage').set('Cookie', parent.cookie);
  const csrf = extractCsrf(manage.text);

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', parent.cookie)
    .set('X-Requested-With', 'fetch')
    .set('X-CSRF-Token', csrf)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.headers.location, undefined);

  const enrollment = await db.prepare('SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, parent.childId);
  assert.equal(enrollment, undefined);
});

test('View/Cancel Classes: fetch-style cancel for someone else\'s child is rejected with JSON, not a redirect', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Guard Rail Class' });
  const parentA = await createParentWithChild();
  const parentB = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ studentId: String(parentA.childId), day: 'monday', _csrf: parentA.csrfToken });

  const res = await request(app)
    .post(`/parent/classes/${cls.id}/unregister`)
    .set('Cookie', parentB.cookie)
    .set('X-Requested-With', 'fetch')
    .set('X-CSRF-Token', parentB.csrfToken)
    .type('form')
    .send({ studentId: String(parentA.childId), day: 'monday' });

  assert.equal(res.status, 403);
  assert.ok(res.body.error);
  const stillEnrolled = await db.prepare('SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, parentA.childId);
  assert.ok(stillEnrolled, 'parent A\'s child should still be enrolled');
});

test('View/Cancel Classes: export.csv lists each family member\'s class and status', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Export Class' });
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const csv = await request(app).get('/parent/classes/manage/export.csv').set('Cookie', parent.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Export Class/);
  assert.match(csv.text, /Registered/);
});

test('Class Dashboard: family-member dropdown, and classes grouped Monday-first then Wednesday', async () => {
  const admin = await loginAsAdmin();
  const mondayClass = await createClass(admin, { className: 'Monday Dash Class', day: 'monday' });
  const wednesdayClass = await createClass(admin, { className: 'Wednesday Dash Class', day: 'wednesday', hourPosition: '2' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${mondayClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  await request(app)
    .post(`/parent/classes/${wednesdayClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'wednesday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get('/parent/classes/dashboard').set('Cookie', parent.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /class-dash-picker-form/);
  assert.match(dashboard.text, /<h2>Monday<\/h2>/);
  assert.match(dashboard.text, /<h2>Wednesday<\/h2>/);
  const mondayIndex = dashboard.text.indexOf('Monday Dash Class');
  const wednesdayIndex = dashboard.text.indexOf('Wednesday Dash Class');
  assert.ok(mondayIndex > 0 && wednesdayIndex > 0 && mondayIndex < wednesdayIndex, 'Monday class should render before the Wednesday class');
  assert.match(dashboard.text, new RegExp(`href="/parent/classes/dashboard/${mondayClass.id}\\?studentId=${parent.childId}"`));
});

// A real request: "classes should be categorized as Monday or Wednesday
// and in time order" - within a day, allClassesList's own default order
// is alphabetical by class name, so two classes on the same day used to
// render in name order, not their actual time-slot order.
test('Class Dashboard: within a day, classes render in time (hour_position) order, not alphabetically', async () => {
  const admin = await loginAsAdmin();
  const laterClass = await createClass(admin, { className: 'A Later Class', day: 'monday', hourPosition: '3' });
  const earlierClass = await createClass(admin, { className: 'Z Earlier Class', day: 'monday', hourPosition: '1' });
  const parent = await createParentWithChild();

  await request(app)
    .post(`/parent/classes/${laterClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });
  await request(app)
    .post(`/parent/classes/${earlierClass.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get('/parent/classes/dashboard').set('Cookie', parent.cookie);
  const earlierIndex = dashboard.text.indexOf('Z Earlier Class');
  const laterIndex = dashboard.text.indexOf('A Later Class');
  assert.ok(earlierIndex > 0 && laterIndex > 0 && earlierIndex < laterIndex, 'the earlier hour_position class should render first, even though its name sorts later alphabetically');
});

test('Class Dashboard detail: shows assignments/grades for the selected child, scoped to only that class', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Detail Dash Class' });
  const otherCls = await createClass(admin, { className: 'Other Dash Class', hourPosition: '2' });
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const assignmentId = await createAssignment({ classId: cls.id, className: cls.class_name, title: 'Reading Log', pointsPossible: 10, createdByAccountId: null });
  await saveGrade({ assignmentId, studentId: parent.childId, pointsEarned: 9, feedback: 'Great work', gradedByAccountId: null });
  await createAssignment({ classId: otherCls.id, className: otherCls.class_name, title: 'Should Not Appear', createdByAccountId: null });

  const detail = await request(app).get(`/parent/classes/dashboard/${cls.id}?studentId=${parent.childId}&tab=grades`).set('Cookie', parent.cookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Reading Log/);
  assert.match(detail.text, /9 \/ 10/);
  assert.match(detail.text, /Great work/);
  assert.doesNotMatch(detail.text, /Should Not Appear/);
});

test('Class Dashboard detail: a class not enrolled in, or a child not in the family, is 404', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Not Enrolled Class' });
  const parent = await createParentWithChild();

  const res = await request(app).get(`/parent/classes/dashboard/${cls.id}?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 404);
});

// A real request: "Classroom dashboard on parent portal should have
// Parent names in drop down menu to show what classes the parent is
// teaching or assisting in. Class card should show Class image on left
// of card." The dashboard's original request ("a dropdown menu... with
// each family member to choose view") already called for every family
// member; only students ever got wired up until now.
test('Class Dashboard: dropdown includes parent names, and selecting one shows the classes they teach/assist', async () => {
  const admin = await loginAsAdmin();
  const taughtClass = await createClass(admin, { className: 'Taught By Parent Class', day: 'monday' });
  const assistedClass = await createClass(admin, { className: 'Assisted By Parent Class', day: 'wednesday', hourPosition: '2' });
  const parent = await createParentWithChild();

  const parentMember = await db.prepare("SELECT * FROM members WHERE name = ?").get(`Dashboard Parent ${familyCounter}`);
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(taughtClass.id, parentMember.id);
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'assistant')").run(assistedClass.id, parentMember.id);

  const dashboard = await request(app).get('/parent/classes/dashboard').set('Cookie', parent.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, new RegExp(`<optgroup label="Parents">[\\s\\S]*?<option value="parent-${parentMember.id}"[^>]*>Dashboard Parent`));

  const teaching = await request(app).get(`/parent/classes/dashboard?viewer=parent-${parentMember.id}`).set('Cookie', parent.cookie);
  assert.equal(teaching.status, 200);
  assert.match(teaching.text, /Taught By Parent Class/);
  assert.match(teaching.text, /Assisted By Parent Class/);
  // A teaching parent's card has nowhere to click through to yet (the
  // detail route below is student-enrollment-only), so it renders as a
  // plain, non-linking card.
  assert.doesNotMatch(teaching.text, new RegExp(`href="/parent/classes/dashboard/${taughtClass.id}`));
});

test('Class Dashboard: a parent teaching/assisting in no classes yet sees an empty state, not their child\'s classes', async () => {
  const admin = await loginAsAdmin();
  await createClass(admin, { className: 'Unrelated Class' });
  const parent = await createParentWithChild();
  const parentMember = await db.prepare("SELECT * FROM members WHERE name = ?").get(`Dashboard Parent ${familyCounter}`);

  const res = await request(app).get(`/parent/classes/dashboard?viewer=parent-${parentMember.id}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`${parentMember.name} isn't teaching or assisting in any classes yet\\.`));
});

test('Class Dashboard: class cards show the class image on the left', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Image Card Class' });
  await db.prepare('UPDATE classes SET image_key = ? WHERE id = ?').run('classes/test-image.jpg', cls.id);
  const parent = await createParentWithChild();
  await request(app)
    .post(`/parent/classes/${cls.id}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'monday', _csrf: parent.csrfToken });

  const dashboard = await request(app).get('/parent/classes/dashboard').set('Cookie', parent.cookie);
  assert.match(dashboard.text, /<img class="class-dash-card-image" src="\/uploads\/classes\/classes\/test-image\.jpg" alt="" \/>/);
});

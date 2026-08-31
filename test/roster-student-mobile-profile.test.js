// A real request: "co-op admin portal, mobile view, class roster. the
// student information bleed right off the page view its too long. on
// mobile view have small organized cards for each student. listing
// name, grade, email button, trash can button. when you click on each
// student on the roster it will popup the parents information. the
// students full information, birthday, grade level, signup date and
// time. Basically their membership profile information." The actual
// mobile-only collapse/click behavior lives in CSS + public/js/roster-
// student-profile.js (a browser/DOM concern this server-side test suite
// has no harness for - manually verified live via Playwright screenshots
// instead). This covers what the server DOES control: the roster row
// carries every field the popup needs as its own data-* attributes, and
// the profile dialog markup - id, header, and one row per field - is
// rendered once per class alongside the roster.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `roster-student-mobile-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `roster-student-mobile-profile-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('a class roster row carries the student\'s full profile as data-* attributes, and the class has its own profile dialog', async () => {
  const cookie = await loginAsAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Roster Profile')").run()).lastInsertRowid;
  const studentId = (
    await db
      .prepare(
        "INSERT INTO members (name, barcode, member_type, grade_level, birthday, family_id) VALUES ('Roster Profile Student', 'roster-profile-student', 'student', '5th', '2015-04-02', ?)"
      )
      .run(familyId)
  ).lastInsertRowid;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, phone, email) VALUES ('Roster Profile Parent', 'roster-profile-parent', 'parent', ?, 1, '555-1212', 'parent@example.com')").run(familyId);

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Profile Roster Class' });
  await setEnrollment(classId, [studentId]);

  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /data-roster-student-card/, 'the roster row should be a click target');
  assert.match(res.text, new RegExp(`data-profile-dialog="roster-student-profile-dialog-${classId}"`), 'the row should point at this class\'s own dialog');
  assert.match(res.text, /data-name="Roster Profile Student"/);
  assert.match(res.text, /data-family="The Roster Profile Family"/);
  assert.match(res.text, /data-grade="5th"/);
  assert.match(res.text, /data-birthday="2015-04-02/);
  assert.match(res.text, /data-parent-name="Roster Profile Parent"/);
  assert.match(res.text, /data-parent-phone="555-1212"/);
  assert.match(res.text, /data-parent-email="parent@example.com"/);
  assert.match(res.text, /class="roster-log-grade-badge"/, 'the compact mobile grade badge should render');

  assert.match(res.text, new RegExp(`id="roster-student-profile-dialog-${classId}"`), 'the class should render its own shared profile dialog');
  assert.match(res.text, /data-profile-field="name"/);
  assert.match(res.text, /data-profile-row="birthday"/);
  assert.match(res.text, /data-profile-row="parent-email"/);
});

test('a class with no enrolled students still renders its own (empty-state) profile dialog, not a missing one', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Empty Roster Class' });
  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`id="roster-student-profile-dialog-${classId}"`));
});

test('the standalone Manage page (admin-class-schedule-manage.ejs) carries the same data-* attributes and dialog as the popup fragment', async () => {
  const cookie = await loginAsAdmin();
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, grade_level) VALUES ('Manage Page Student', 'manage-page-student', 'student', '2nd')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Manage Page Roster Class' });
  await setEnrollment(classId, [studentId]);

  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /data-roster-student-card/);
  assert.match(res.text, /data-name="Manage Page Student"/);
  assert.match(res.text, new RegExp(`id="roster-student-profile-dialog-${classId}"`));
});

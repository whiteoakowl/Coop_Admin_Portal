// "We don't need any archive features under classes tab either on co-op
// admin portal. Everything is connected to semesters so we don't need
// individual archiving anymore." The Class Archive feature (the
// checkbox+Archive button on each day's Classes grid, the Class/Student/
// Parent Archive sub-tabs on the Schedules page) was removed entirely.
// archiveClasses used to be the only thing that ever wrote a Transcript
// entry (student_academic_history) for a student who completed a class -
// generateTranscriptsForEndedClasses (utils/academics.js) replaces that:
// once a class's own end_date has passed, its enrolled students each get
// a transcript row automatically, backfilled lazily on the Main Admin
// Academics page's own GET route rather than through any admin action.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `academics-auto-transcript-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `academics-auto-transcript-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { todayISO, addDays } = require('../utils/dates');

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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie };
}

test('a class whose end_date has passed gets its enrolled students auto-transcribed the next time the Academics page loads', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const yesterday = addDays(todayISO(), -1);

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Ended Pottery Class', endDate: yesterday });
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Transcript Kid', 'transcript-kid', 'student', 1)")
    .run();
  const studentId = studentInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
  const teacherInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Pottery Teacher', 'pottery-teacher', 'parent', 1)").run();
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherInfo.lastInsertRowid);

  const page = await request(app).get('/main-admin/academics').set('Cookie', mainAdmin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ended Pottery Class/);
  assert.match(page.text, /Pottery Teacher/);

  const row = await db.prepare('SELECT * FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(studentId, classId);
  assert.ok(row, 'a transcript row should have been auto-generated');
  assert.equal(row.class_name, 'Ended Pottery Class');
  assert.equal(row.term_ended_at, yesterday);

  // Loading the page again must not duplicate the row.
  await request(app).get('/main-admin/academics').set('Cookie', mainAdmin.cookie);
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(studentId, classId);
  assert.equal(Number(countRow.c), 1, 'revisiting the Academics page should not create a second transcript row for the same class');
});

test('a class whose end_date has not passed yet is left alone', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const tomorrow = addDays(todayISO(), 1);

  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Still Running Class', endDate: tomorrow });
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Still Enrolled Kid', 'still-enrolled-kid', 'student', 1)")
    .run();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentInfo.lastInsertRowid);

  await request(app).get('/main-admin/academics').set('Cookie', mainAdmin.cookie);
  const row = await db.prepare('SELECT * FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(studentInfo.lastInsertRowid, classId);
  assert.equal(row, undefined, 'a still-running class should not generate a transcript entry yet');
});

test('the Classes grid no longer has an Archive button/checkboxes, and every Class Archive route 404s', async () => {
  const admin = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /class-archive-form/);
  assert.doesNotMatch(page.text, /data-archive-toggle="class-archive-form/);
  assert.doesNotMatch(page.text, /Add\/Edit Semester/);
  assert.doesNotMatch(page.text, /semester-manager-dialog-monday/);

  assert.equal((await request(app).post('/admin/class-schedule/monday/archive').set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken })).status, 404);
  assert.equal((await request(app).get('/admin/class-schedule/archive/export.csv').set('Cookie', admin.cookie)).status, 404);
  assert.equal((await request(app).get('/admin/schedule?tab=archive').set('Cookie', admin.cookie)).status, 200, 'an unrecognized tab just falls back to the default day grid, not a 404');
  const archivePage = await request(app).get('/admin/schedule?tab=archive').set('Cookie', admin.cookie);
  assert.doesNotMatch(archivePage.text, /Archived At/);
});

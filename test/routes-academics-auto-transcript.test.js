// "We don't need any archive features under classes tab either on co-op
// admin portal. Everything is connected to semesters so we don't need
// individual archiving anymore." The Class Archive feature (the
// checkbox+Archive button on each day's Classes grid, the Class/Student/
// Parent Archive sub-tabs on the Schedules page) was removed entirely.
// archiveClasses used to be the only thing that ever wrote a Transcript
// entry (student_academic_history) for a student who completed a class -
// generateTranscriptsForEndedClasses (utils/academics.js) replaces that:
// once a class's own end_date has passed, its enrolled students each get
// a transcript row automatically, backfilled lazily on a transcript-
// reading GET route rather than through any admin action. That backfill
// used to run on Main Admin's own /academics page; a later real request
// ("Main admin portal, remove academics tab and features. Only parent
// portal has those pages and admin doesn't need to control them with any
// settings.") removed that whole page, so it moved to Student Portal's
// own /student/transcript route - the one other place that already read
// this same data.
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

let counter = 0;
async function loginAsStudent(name) {
  counter += 1;
  const code = `transcript-student-${counter}`;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)")
    .run(name, code);
  const studentId = studentInfo.lastInsertRowid;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(studentId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { studentId, cookie: loginRes.headers['set-cookie'] };
}

test('a class whose end_date has passed gets its enrolled students auto-transcribed the next time their own Transcript page loads', async () => {
  const yesterday = addDays(todayISO(), -1);

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Ended Pottery Class', endDate: yesterday });
  const student = await loginAsStudent('Transcript Kid');
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.studentId);
  const teacherInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Pottery Teacher', 'pottery-teacher', 'parent', 1)").run();
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherInfo.lastInsertRowid);

  const page = await request(app).get('/student/transcript').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ended Pottery Class/);
  assert.match(page.text, /Pottery Teacher/);

  const row = await db.prepare('SELECT * FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(student.studentId, classId);
  assert.ok(row, 'a transcript row should have been auto-generated');
  assert.equal(row.class_name, 'Ended Pottery Class');
  assert.equal(row.term_ended_at, yesterday);

  // Loading the page again must not duplicate the row.
  await request(app).get('/student/transcript').set('Cookie', student.cookie);
  const countRow = await db.prepare('SELECT COUNT(*) AS c FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(student.studentId, classId);
  assert.equal(Number(countRow.c), 1, 'revisiting the Transcript page should not create a second transcript row for the same class');
});

test('a class whose end_date has not passed yet is left alone', async () => {
  const tomorrow = addDays(todayISO(), 1);

  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Still Running Class', endDate: tomorrow });
  const student = await loginAsStudent('Still Enrolled Kid');
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.studentId);

  await request(app).get('/student/transcript').set('Cookie', student.cookie);
  const row = await db.prepare('SELECT * FROM student_academic_history WHERE student_id = ? AND class_id = ?').get(student.studentId, classId);
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

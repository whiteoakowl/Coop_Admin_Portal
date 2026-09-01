// HTTP-level coverage for the Student Portal's new "Classes" card list +
// class detail page (a real request: a card list with a Monday/Wednesday/
// All filter, plus a class detail view with tabs for Assignments/Lessons/
// Class Forum/Resources/Attendance/Assessments/Grades). This first pass is
// read-only: Assignments/Grades/Attendance reuse real existing data
// (utils/academics.js, the class's own auto-roster attendance), Class
// Forum links to the class's real /forums/:id category when a Main Admin
// has created one, and Lessons/Assessments/Resources are simple stubs
// since there's no per-class content model for those yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `student-class-detail-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `student-class-detail-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const classSchedule = require('../utils/classSchedule');
const academics = require('../utils/academics');
const forums = require('../utils/forums');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;

async function createStudent(name) {
  counter++;
  const barcode = `class-detail-test-${counter}`;
  const email = `class-detail-test-${counter}@example.com`;
  const memberId = (
    await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(name, barcode, 'student')
  ).lastInsertRowid;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'active')")
      .run(memberId, email, hashPassword('testpassword123'))
  ).lastInsertRowid;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const res = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { memberId, cookie: res.headers['set-cookie'] };
}

async function createClassWithTeacher(day, className, teacherName) {
  const classId = await classSchedule.createClass({ day, hourPosition: 1, className, room: 'Room 1' });
  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'admin')").run(teacherName, `teacher-${classId}`)
  ).lastInsertRowid;
  await classSchedule.addStaff(classId, teacherId, 'teacher');
  return classId;
}

test('My Classes shows only this student\'s own enrolled classes', async () => {
  const { memberId, cookie } = await createStudent('Classes Card Student');
  const enrolledId = await createClassWithTeacher('monday', 'Enrolled Art Class', 'Ms. Art');
  const otherId = await createClassWithTeacher('wednesday', 'Not Enrolled Science Class', 'Mr. Science');
  await classSchedule.setEnrollment(enrolledId, [memberId]);

  const res = await request(app).get('/student/classes').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Enrolled Art Class/);
  assert.doesNotMatch(res.text, /Not Enrolled Science Class/);
  assert.match(res.text, new RegExp(`data-day="monday"[\\s\\S]*?Enrolled Art Class`));
  void otherId;
});

test('a class detail page 404s for a class this student is not enrolled in', async () => {
  const { cookie } = await createStudent('Not Enrolled Student');
  const classId = await createClassWithTeacher('monday', 'Someone Else\'s Class', 'Ms. Teacher');
  const res = await request(app).get(`/student/classes/${classId}`).set('Cookie', cookie);
  assert.equal(res.status, 404);
});

test('class detail page defaults to Assignments and shows only this class\'s own assignments', async () => {
  const { memberId, cookie } = await createStudent('Assignments Student');
  const classAId = await createClassWithTeacher('monday', 'Class A', 'Teacher A');
  const classBId = await createClassWithTeacher('wednesday', 'Class B', 'Teacher B');
  await classSchedule.setEnrollment(classAId, [memberId]);
  await classSchedule.setEnrollment(classBId, [memberId]);
  await academics.createAssignment({ classId: classAId, className: 'Class A', title: 'Class A Homework', dueDate: '2026-09-05', pointsPossible: 10 });
  await academics.createAssignment({ classId: classBId, className: 'Class B', title: 'Class B Homework', dueDate: '2026-09-06', pointsPossible: 10 });

  const res = await request(app).get(`/student/classes/${classAId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Class A Homework/);
  assert.doesNotMatch(res.text, /Class B Homework/);
  assert.match(res.text, /Not graded yet/);
});

test('Grades tab shows only graded assignments with their score', async () => {
  const { memberId, cookie } = await createStudent('Grades Student');
  const classId = await createClassWithTeacher('monday', 'Graded Class', 'Teacher G');
  await classSchedule.setEnrollment(classId, [memberId]);
  const ungradedId = await academics.createAssignment({ classId, className: 'Graded Class', title: 'Ungraded Work', pointsPossible: 10 });
  const gradedId = await academics.createAssignment({ classId, className: 'Graded Class', title: 'Graded Work', pointsPossible: 20 });
  await academics.saveGrade({ assignmentId: gradedId, studentId: memberId, pointsEarned: 18, feedback: 'Great job!' });
  void ungradedId;

  const res = await request(app).get(`/student/classes/${classId}?tab=grades`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Graded Work/);
  assert.match(res.text, /18\s*\/\s*20/);
  assert.match(res.text, /Great job!/);
  assert.doesNotMatch(res.text, /Ungraded Work/);
});

test('Attendance tab shows this student\'s own attendance for the class\'s own roster', async () => {
  const { memberId, cookie } = await createStudent('Attendance Student');
  const classId = await createClassWithTeacher('monday', 'Attendance Class', 'Teacher A');
  await classSchedule.setEnrollment(classId, [memberId]);
  const cls = await classSchedule.getClass(classId);
  assert.ok(cls.roster_id, 'a class should always have its own auto-roster');
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2026-09-07', 'present', ?, 'kiosk')")
    .run(memberId, cls.roster_id, Date.now());

  const res = await request(app).get(`/student/classes/${classId}?tab=attendance`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /status-badge-present/);
  assert.match(res.text, /Present/);
});

test('Class Forum tab links to the class\'s own forum category when one exists, otherwise says none is set up', async () => {
  const { memberId, cookie } = await createStudent('Forum Student');
  const classId = await createClassWithTeacher('monday', 'Forum Class', 'Teacher F');
  await classSchedule.setEnrollment(classId, [memberId]);

  const noForumRes = await request(app).get(`/student/classes/${classId}?tab=forum`).set('Cookie', cookie);
  assert.equal(noForumRes.status, 200);
  assert.match(noForumRes.text, /No chat has been set up/);

  const categoryId = await forums.createCategory({ name: 'Forum Class Chat', scope: 'class', classId });
  const withForumRes = await request(app).get(`/student/classes/${classId}?tab=forum`).set('Cookie', cookie);
  assert.equal(withForumRes.status, 200);
  assert.match(withForumRes.text, new RegExp(`/forums/${categoryId}`));
});

test('Lessons and Assessments tabs render a stub without crashing', async () => {
  const { memberId, cookie } = await createStudent('Stub Tabs Student');
  const classId = await createClassWithTeacher('monday', 'Stub Class', 'Teacher S');
  await classSchedule.setEnrollment(classId, [memberId]);

  const lessonsRes = await request(app).get(`/student/classes/${classId}?tab=lessons`).set('Cookie', cookie);
  assert.equal(lessonsRes.status, 200);
  assert.match(lessonsRes.text, /Coming soon/);

  const assessmentsRes = await request(app).get(`/student/classes/${classId}?tab=assessments`).set('Cookie', cookie);
  assert.equal(assessmentsRes.status, 200);
  assert.match(assessmentsRes.text, /Coming soon/);
});

test('Resources tab links out to the global Resource Links page instead of fabricating class-scoped data', async () => {
  const { memberId, cookie } = await createStudent('Resources Student');
  const classId = await createClassWithTeacher('monday', 'Resources Class', 'Teacher R');
  await classSchedule.setEnrollment(classId, [memberId]);

  const res = await request(app).get(`/student/classes/${classId}?tab=resources`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/student\/resources"/);
});

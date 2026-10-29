// Coverage for a real request: "Student portal add a tab that says
// family homeschooling. Subpages are, homeschool overview, homeschool
// classes, homeschool grades, weekly planner." Student Portal's own
// single "Family School Management" link (no subpages) becomes a tab
// with 4 subpages; Overview/Grades/Weekly Planner are brand new,
// read-only pages reusing the exact same utils/familySchool.js functions
// Parent Portal's own identical (editable) pages already use. Classes
// was already there (routes/student-family-school.js's own existing
// GET /family-school), just reachable from a new nav position now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `student-family-homeschooling-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `student-family-homeschooling-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const {
  createClass,
  assignClassToStudents,
  createLesson,
  createContentItem,
  submitAssignment,
  gradeAssignmentSubmission,
  createWeek,
  createWeekAssignment,
} = require('../utils/familySchool');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createStudent(name, familyId) {
  counter += 1;
  const code = `fhstudent${counter}`;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, grade_level) VALUES (?, ?, ?, 'student', ?, 1, '5th') RETURNING id")
      .get(name, code, code, familyId)
  ).id;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

// A later real request: "Family homeschooling shouldn't be a tab anymore
// on student portal. Co-op classes and family school management classes
// are all under classroom dashboard subpages together" - the standalone
// Family Homeschooling tab is gone; its own subpages (Overview/Classes/
// Grades/Weekly Planner) now live under the Classroom Dashboard tab
// instead, alongside Co-op Classes.
test('Student Portal nav: no standalone Family Homeschooling tab - its pages live under Classroom Dashboard instead', async () => {
  const familyId = await createFamily('Nav Family');
  const student = await createStudent('Nav Student', familyId);
  const page = await request(app).get('/student').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, />Family Homeschooling</);
  assert.match(page.text, />Classroom Dashboard</);
  assert.match(page.text, /href="\/student\/classes">Co-op Classes/);
  assert.match(page.text, /href="\/student\/family-school">Family School Classes/);
  assert.match(page.text, /href="\/student\/family-school\/grades">Grades/);
  assert.match(page.text, /href="\/student\/family-school\/weekly-planner">Weekly Planner/);
  assert.match(page.text, /href="\/student\/family-school\/overview">Overview/);
});

test('Homeschool Overview shows this one student\'s own GPA, attendance, and classes', async () => {
  const familyId = await createFamily('Overview Family');
  const student = await createStudent('Overview Student', familyId);
  const classId = await createClass({ familyId, className: 'Overview Science', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson 1', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Quiz', pointsPossible: 10 });
  await submitAssignment({ contentItemId: itemId, studentId: student.memberId, fileUrl: 'key', fileName: 'quiz.pdf' });
  await gradeAssignmentSubmission({ contentItemId: itemId, studentId: student.memberId, pointsEarned: 9, gradeLetter: 'A', feedback: 'Great work' });

  const page = await request(app).get('/student/family-school/overview').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Overview Student/);
  assert.match(page.text, /Overview Science/);
  assert.match(page.text, />A</);
});

test('Homeschool Grades shows this one student\'s own graded/ungraded assignments', async () => {
  const familyId = await createFamily('Grades Family');
  const student = await createStudent('Grades Student', familyId);
  const classId = await createClass({ familyId, className: 'Grades Math', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Fractions', description: null, createdByAccountId: null });
  await createContentItem({ lessonId, type: 'assignment_submission', title: 'Worksheet', pointsPossible: 20 });

  const page = await request(app).get('/student/family-school/grades').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Grades Math/);
  assert.match(page.text, /Worksheet/);
  assert.match(page.text, /Not graded yet/);
});

test('Weekly Planner shows this one student\'s own week and the family\'s own weeks, read-only (no add/delete controls)', async () => {
  const familyId = await createFamily('Planner Family');
  const student = await createStudent('Planner Student', familyId);
  const weekId = await createWeek({ familyId, ownerType: 'student', studentId: student.memberId, title: 'Week 1', dates: ['2026-09-07', '2026-09-09'], createdByAccountId: null });
  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ? ORDER BY position LIMIT 1').get(weekId);
  await createWeekAssignment({ weekDateId: dateRow.id, subject: 'Math', title: 'Chapter 4', contentItemId: null });
  await createWeek({ familyId, ownerType: 'family', studentId: null, title: 'Family Week', dates: ['2026-09-10'], createdByAccountId: null });

  const listPage = await request(app).get('/student/family-school/weekly-planner').set('Cookie', student.cookie);
  assert.equal(listPage.status, 200);
  assert.match(listPage.text, /Week 1/);
  assert.match(listPage.text, /Family Week/);

  const page = await request(app).get(`/student/family-school/weekly-planner?weekId=${weekId}`).set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Math/);
  assert.match(page.text, /Chapter 4/);
  assert.doesNotMatch(page.text, /\+ Add Week/);
  assert.doesNotMatch(page.text, /\+ Assignment/);
  assert.doesNotMatch(page.text, /icon-btn-danger/, 'no delete controls on the read-only student view');
});

test('a student from a DIFFERENT family never sees another family\'s homeschool data', async () => {
  const familyA = await createFamily('Isolation Family A');
  const familyB = await createFamily('Isolation Family B');
  const studentA = await createStudent('Isolation Student A', familyA);
  const studentB = await createStudent('Isolation Student B', familyB);

  const classId = await createClass({ familyId: familyA, className: 'Family A Only Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [studentA.memberId]);
  const lessonId = await createLesson({ classId, title: 'A Only Lesson', description: null, createdByAccountId: null });
  await createContentItem({ lessonId, type: 'assignment_submission', title: 'A Only Assignment', pointsPossible: 10 });

  const overviewB = await request(app).get('/student/family-school/overview').set('Cookie', studentB.cookie);
  assert.doesNotMatch(overviewB.text, /Family A Only Class/);
  assert.doesNotMatch(overviewB.text, /Isolation Student A/);

  const gradesB = await request(app).get('/student/family-school/grades').set('Cookie', studentB.cookie);
  assert.doesNotMatch(gradesB.text, /A Only Assignment/);
});

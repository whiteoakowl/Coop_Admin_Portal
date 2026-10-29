// Coverage for a real request: "Classroom dashboard should be a menu
// tab as well. Classroom dashboard subpages. Classes, grades,
// attendance, chat, portfolio, transcripts. overview, which shows
// volunteer hours, days of school attendance from family school
// management, GPA, etc." Adds a new Classroom Dashboard nav tab
// (views/partials/portal-nav.ejs) alongside the existing Classes/Family
// Homeschooling tabs, plus brand-new read-only Attendance/Portfolio
// subpages (routes/student-family-school.js) and a Volunteer Hours stat
// on the existing Homeschool Overview page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `student-classroom-dashboard-tab-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `student-classroom-dashboard-tab-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { toggleAttendance, createVolunteerHourEntry, currentSchoolYear } = require('../utils/familySchool');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createStudent(name) {
  counter += 1;
  const code = `classdash${counter}`;
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES (?) RETURNING id").get(`${name} Family`)).id;
  const email = `${code}@example.com`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
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
  return { memberId, familyId, cookie: loginRes.headers['set-cookie'] };
}

// A later real request: "Family homeschooling shouldn't be a tab anymore
// on student portal. Co-op classes and family school management classes
// are all under classroom dashboard subpages together" - Co-op Classes
// and Family School Classes (plus Weekly Planner, the only other page
// that used to live solely under the now-removed Family Homeschooling
// tab) joined this tab's own subpages.
test('Student Portal nav: Classroom Dashboard is a tab with Co-op + Family School classes and every other requested subpage', async () => {
  const student = await createStudent('Nav Student');
  const page = await request(app).get('/student').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Classroom Dashboard</);
  assert.match(page.text, /href="\/student\/classes">Co-op Classes</);
  assert.match(page.text, /href="\/student\/family-school">Family School Classes</);
  assert.match(page.text, /href="\/student\/family-school\/grades">Grades</);
  assert.match(page.text, /href="\/student\/family-school\/attendance">Attendance</);
  assert.match(page.text, /href="\/student\/family-school\/weekly-planner">Weekly Planner</);
  assert.match(page.text, /href="\/forums\?portal=student">Chat</);
  assert.match(page.text, /href="\/student\/family-school\/portfolio">Portfolio</);
  assert.match(page.text, /href="\/student\/transcript">Transcripts</);
  assert.match(page.text, /href="\/student\/family-school\/overview">Overview</);
});

test('Attendance subpage shows this student\'s own present/absent days for the current school year, read-only', async () => {
  const student = await createStudent('Attendance Student');
  const startYear = parseInt(currentSchoolYear().slice(0, 4), 10);
  await toggleAttendance(student.memberId, `${startYear}-09-02`); // present
  await toggleAttendance(student.memberId, `${startYear}-09-03`); // present
  await toggleAttendance(student.memberId, `${startYear}-09-03`); // absent

  const page = await request(app).get('/student/family-school/attendance').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Attendance/);
  assert.match(page.text, /fs-attendance-day-present"[^>]*>2</);
  assert.match(page.text, /fs-attendance-day-absent"[^>]*>3</);
  // Read-only - no click-to-toggle data attributes or JS.
  assert.doesNotMatch(page.text, /data-fs-attendance-cell/);
  assert.doesNotMatch(page.text, /family-school-attendance\.js/);
});

test('Portfolio subpage summarizes this student\'s own classes, GPA, attendance, and volunteer hours', async () => {
  const student = await createStudent('Portfolio Student');
  await createVolunteerHourEntry({ studentId: student.memberId, hourDate: '2026-04-01', hours: 3, activityDescription: 'Library', createdByAccountId: null });
  await createVolunteerHourEntry({ studentId: student.memberId, hourDate: '2026-04-02', hours: 2, activityDescription: 'Park cleanup', createdByAccountId: null });

  const page = await request(app).get('/student/family-school/portfolio').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Portfolio<\/h1>/);
  assert.match(page.text, /Portfolio Student/);
  assert.match(page.text, /Volunteer Hours/);
  assert.match(page.text, /fs-overview-stat-value">5</); // 3 + 2 hours
});

test('Homeschool Overview now shows a Volunteer Hours stat alongside GPA and Attendance', async () => {
  const student = await createStudent('Overview Student');
  await createVolunteerHourEntry({ studentId: student.memberId, hourDate: '2026-04-01', hours: 4, activityDescription: 'Food bank', createdByAccountId: null });

  const page = await request(app).get('/student/family-school/overview').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />GPA</);
  assert.match(page.text, />Attendance</);
  assert.match(page.text, />Volunteer Hours</);
  assert.match(page.text, /fs-overview-stat-value">4</);
});

test("a student from a DIFFERENT family never sees another family's attendance or portfolio", async () => {
  const studentA = await createStudent('Family A Student');
  const studentB = await createStudent('Family B Student');
  const startYear = parseInt(currentSchoolYear().slice(0, 4), 10);
  await toggleAttendance(studentA.memberId, `${startYear}-09-05`); // present for A only
  await createVolunteerHourEntry({ studentId: studentA.memberId, hourDate: '2026-04-01', hours: 7, activityDescription: 'A only', createdByAccountId: null });

  const attendancePage = await request(app).get('/student/family-school/attendance').set('Cookie', studentB.cookie);
  assert.doesNotMatch(attendancePage.text, /fs-attendance-day-present"[^>]*>5</);

  const portfolioPage = await request(app).get('/student/family-school/portfolio').set('Cookie', studentB.cookie);
  assert.match(portfolioPage.text, /Family B Student/);
  assert.doesNotMatch(portfolioPage.text, /Family A Student/);
  assert.doesNotMatch(portfolioPage.text, /fs-overview-stat-value">7</);
});

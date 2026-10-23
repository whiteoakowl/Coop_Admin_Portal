// Coverage for a real request: "Family school management, add a
// subpage called portfolio. This will summarize all family school
// management features for each student and create a visual profile of
// everything. Pdf and print view." utils/familySchool.js's own
// portfolioForStudent aggregates classes/grades/GPA, attendance,
// Volunteer Hours, Curriculum, recent Daily Learning Log entries, and
// the student's most recent Weekly Planner week - routes/parent-
// family-school.js's own /portfolio, /portfolio/print, and
// /portfolio/download.pdf routes just pick which student and render it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fs-portfolio-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fs-portfolio-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const {
  createClass,
  assignClassToStudents,
  createLesson,
  createContentItem,
  submitAssignment,
  toggleAttendance,
  createVolunteerHourEntry,
  createCurriculumItem,
  createJournalEntry,
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

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `fsport${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

test('Portfolio summarizes grades/GPA, attendance, volunteer hours, curriculum, journal, and the most recent week for one student', async () => {
  const familyId = await createFamily('Portfolio Family');
  const parent = await createPortalMember({ name: 'Portfolio Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Portfolio Student', familyId, memberType: 'student', roleKey: 'student' });

  const classId = await createClass({ familyId, className: 'Portfolio Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Quiz', pointsPossible: 10 });
  await submitAssignment({ contentItemId: itemId, studentId: student.memberId, fileUrl: 'key', fileName: 'quiz.pdf' });
  const csrf1 = await request(app).get('/parent/family-school').set('Cookie', parent.cookie).then((r) => /name="csrf-token" content="([^"]*)"/.exec(r.text)[1]);
  await request(app)
    .post(`/parent/family-school/grades/${itemId}/${student.memberId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ pointsEarned: '10', gradeLetter: '', feedback: '', _csrf: csrf1 });

  await toggleAttendance(student.memberId, '2026-04-01');
  await toggleAttendance(student.memberId, '2026-04-02');

  await createVolunteerHourEntry({ studentId: student.memberId, hourDate: '2026-04-01', hours: 3, activityDescription: 'Library', createdByAccountId: parent.accountId });
  await createVolunteerHourEntry({ studentId: student.memberId, hourDate: '2026-04-02', hours: 2, activityDescription: 'Park cleanup', createdByAccountId: parent.accountId });

  await createCurriculumItem({ studentId: student.memberId, name: 'Saxon Math 5', subject: 'Math', brand: 'Saxon', level: '5', price: 60, schoolYear: '2026-2027', createdByAccountId: parent.accountId });

  await createJournalEntry({ studentId: student.memberId, entryDate: '2026-04-03', body: '<p>Great day of science experiments.</p>', createdByAccountId: parent.accountId });

  const weekId = await createWeek({ familyId, ownerType: 'student', studentId: student.memberId, title: 'Week 1', dates: ['2026-04-06'], createdByAccountId: parent.accountId });
  const weekGrid = await require('../utils/familySchool').weekGrid(weekId);
  await createWeekAssignment({ weekDateId: weekGrid[0].id, subject: 'Math', title: 'Chapter 3' });
  await createWeekAssignment({ weekDateId: weekGrid[0].id, subject: 'Reading', title: 'Chapter 4' });

  const page = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Portfolio Student/);
  assert.match(page.text, /4\.00/, '10/10 = 100% is an A, averaging to a 4.00 GPA');
  assert.match(page.text, />A</);
  assert.match(page.text, /2\/180/, 'two present days over the 180-day target');
  assert.match(page.text, /fs-attendance-bar-fill/, 'the shared 180-day bar graph renders here too');
  assert.match(page.text, />5<\/span>/, 'volunteer hours total: 3 + 2 = 5');
  assert.match(page.text, /Saxon Math 5/);
  assert.match(page.text, /Great day of science experiments/);
  assert.match(page.text, /Week 1/);
  assert.match(page.text, /Math/);
  assert.match(page.text, /Reading/);
  assert.match(page.text, /50%/, 'one Math + one Reading assignment in the week splits 50\\/50');

  const print = await request(app).get(`/parent/family-school/portfolio/print?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(print.status, 200);
  assert.match(print.text, /Portfolio Student/);
  assert.match(print.text, /Saxon Math 5/);
});

// A real request: "Family school management. Filter buttons should
// have student dropdown choice and school year choice." Portfolio's
// own School Year select narrows GPA (assignment due_date), present
// days (attendance_date), and curriculum (already year-tagged) to
// one Aug-Jul span.
test('Portfolio: the Filter popover offers a School Year dropdown that narrows GPA, attendance, and curriculum to that year', async () => {
  const familyId = await createFamily('Portfolio School Year Family');
  const parent = await createPortalMember({ name: 'Portfolio Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Portfolio Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const classId = await createClass({ familyId, className: 'Portfolio Year Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson', description: null, createdByAccountId: null });
  const fallItemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Fall Quiz', pointsPossible: 10, dueDate: '2024-10-01' });
  const springItemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Spring Quiz', pointsPossible: 10, dueDate: '2026-04-02' });
  await submitAssignment({ contentItemId: fallItemId, studentId: student.memberId, fileUrl: 'key', fileName: 'fall.pdf' });
  await submitAssignment({ contentItemId: springItemId, studentId: student.memberId, fileUrl: 'key', fileName: 'spring.pdf' });
  const csrf = await request(app).get('/parent/family-school').set('Cookie', parent.cookie).then((r) => /name="csrf-token" content="([^"]*)"/.exec(r.text)[1]);
  await request(app).post(`/parent/family-school/grades/${fallItemId}/${student.memberId}`).set('Cookie', parent.cookie).type('form').send({ pointsEarned: '10', gradeLetter: '', feedback: '', _csrf: csrf });
  await request(app).post(`/parent/family-school/grades/${springItemId}/${student.memberId}`).set('Cookie', parent.cookie).type('form').send({ pointsEarned: '0', gradeLetter: '', feedback: '', _csrf: csrf });

  await toggleAttendance(student.memberId, '2024-10-05');
  await toggleAttendance(student.memberId, '2026-04-05');

  await createCurriculumItem({ studentId: student.memberId, name: 'Fall Curriculum', subject: 'Math', brand: null, level: null, price: 10, schoolYear: '2024-2025', createdByAccountId: parent.accountId });
  await createCurriculumItem({ studentId: student.memberId, name: 'Spring Curriculum', subject: 'Science', brand: null, level: null, price: 10, schoolYear: '2026-2027', createdByAccountId: parent.accountId });

  const allYears = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(allYears.status, 200);
  assert.match(allYears.text, /<select id="portfolio-school-year-select" name="schoolYear" onchange="this\.form\.submit\(\)">/);
  assert.match(allYears.text, /<option value="all" selected>All Years<\/option>/);
  assert.match(allYears.text, /2\/180/, '10/10 + 0/10 graded, but both present days count with no year filter');
  assert.match(allYears.text, /Fall Curriculum/);
  assert.match(allYears.text, /Spring Curriculum/);

  const filtered = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /<option value="2024-2025" selected>2024-2025<\/option>/);
  assert.match(filtered.text, /4\.00/, 'only the Fall Quiz (10\\/10 = 100%) counts within 2024-2025, an A/4.00 GPA');
  assert.match(filtered.text, /1\/180/, 'only the 2024-10-05 present day falls within 2024-2025');
  assert.match(filtered.text, /Fall Curriculum/);
  assert.doesNotMatch(filtered.text, /Spring Curriculum/);
});

test('a parent from a different family cannot load another family\'s student portfolio', async () => {
  const familyId = await createFamily('Portfolio Family Owner');
  const owner = await createPortalMember({ name: 'Portfolio Owner Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Portfolio Owner Student', familyId, memberType: 'student', roleKey: 'student' });

  const otherFamilyId = await createFamily('Portfolio Family Outsider');
  const outsider = await createPortalMember({ name: 'Portfolio Outsider Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });

  const outsiderPage = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}`).set('Cookie', outsider.cookie);
  assert.equal(outsiderPage.status, 200);
  assert.doesNotMatch(outsiderPage.text, /Portfolio Owner Student/);

  const ownerPage = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}`).set('Cookie', owner.cookie);
  assert.match(ownerPage.text, /Portfolio Owner Student/);
});

test('a student with no data anywhere still renders empty-state messaging, not an error', async () => {
  const familyId = await createFamily('Portfolio Empty Family');
  const parent = await createPortalMember({ name: 'Portfolio Empty Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Portfolio Empty Student', familyId, memberType: 'student', roleKey: 'student' });

  const page = await request(app).get(`/parent/family-school/portfolio?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Not assigned to any family classes yet\./);
  assert.match(page.text, /No curriculum added yet\./);
  assert.match(page.text, /No journal entries yet\./);
  assert.match(page.text, /No weekly plans yet\./);
});

test('download.pdf returns a real PDF for a student with data', async () => {
  const familyId = await createFamily('Portfolio PDF Family');
  const parent = await createPortalMember({ name: 'Portfolio PDF Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Portfolio PDF Student', familyId, memberType: 'student', roleKey: 'student' });
  const res = await request(app).get(`/parent/family-school/portfolio/download.pdf?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.body.slice(0, 4).toString(), '%PDF');
});

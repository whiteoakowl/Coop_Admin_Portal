// Coverage for a real request: "Parent portal, student portal and main
// admin portal add a tab called family school management. Under this tab
// parent can create classed, lessons and assignments and assign these
// classes to their own students in their family. These classes will then
// appear under the students portal to work ok and complete. Parents can
// edit, track and view all of it. Subpage for grades, subapge for parent
// to take attendance by the date. View a calendar and mark days student
// is present for school by clicking on the date and it highlights gren.
// If you click again it becomes red for didn't do school. Subpage for
// teacher journal. Add journal/notes entry by date and by student in the
// family. Full edit description typing box. Then a log below showing
// all entries. These classes are completely seperate from co-op classes
// and schedules as well as co-op teachers. It has nothing to do with
// that at all. On main admin the family school management tab simply
// has settings. Leave settings for that blank for now."
// (utils/familySchool.js, routes/parent-family-school.js, routes/
// student-family-school.js, routes/main-admin-family-school.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `family-school-management-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `family-school-management-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

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
  const code = `fstest${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey === 'main_admin' ? 'main-admin' : roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

// A later real request: "Homeschool family management tab on parent
// portal. It needs to become its own portal and all the subpages
// becomes the tabs." Family School Management is no longer a Parent
// Portal nav tab - it's reached via the Portal Switcher's own second
// card for the 'parent' role (routes/portal-auth.js's own
// expandPortalRoles), with every one of its old subpages now a direct
// top-level tab in its own nav shell (views/partials/portal-nav.ejs's
// own FAMILY_SCHOOL_NAV_LINKS). Student/Main Admin's own tabs for this
// feature are untouched (the user only asked about Parent Portal).
test('Family School Management is its own portal reached from the parent role, and the Student/Main Admin tabs are unaffected', async () => {
  const familyId = await createFamily('Nav Family');
  const parent = await createPortalMember({ name: 'Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Nav Student', familyId, memberType: 'student', roleKey: 'student' });
  const mainAdmin = await createPortalMember({ name: 'Nav Admin', familyId: null, memberType: 'admin', roleKey: 'main_admin' });

  const parentHome = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.doesNotMatch(parentHome.text, />Family School(?:<br\/?>| )Management</, 'Family School Management is no longer a Parent Portal nav tab');
  // A parent-only account now reaches two portals from that one role -
  // "Switch Portal" must show even though it holds only one real role.
  assert.match(parentHome.text, /Switch Portal/);

  const switcher = await request(app).get('/portal').set('Cookie', parent.cookie);
  assert.match(switcher.text, /class="portal-picker-title">Family School Management</);
  assert.match(switcher.text, /href="\/parent\/family-school"/);

  const fsmHome = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(fsmHome.status, 200);
  assert.match(fsmHome.text, /<p class="portal-nav-title">Family School Management<\/p>/);
  // Every old subpage is now a direct top-level tab, not nested under a
  // Family School Management group.
  assert.match(fsmHome.text, /href="\/parent\/family-school\/classes"/);
  assert.match(fsmHome.text, /href="\/parent\/family-school\/weekly-planner"/);
  // A later real request moved Settings out of this tab list and behind
  // the gear icon instead (test/family-school-settings.test.js's own
  // "Settings gear" test covers the gear's own new destination).
  assert.doesNotMatch(fsmHome.text, /href="\/parent\/family-school\/settings"/);

  // A later real request ("Student portal add a tab that says family
  // homeschooling...") renamed Student Portal's own nav entry for this
  // feature and gave it subpages - see test/student-family-homeschooling-
  // tab.test.js for coverage of that tab itself.
  const studentHome = await request(app).get('/student').set('Cookie', student.cookie);
  assert.match(studentHome.text, />Family Homeschooling</);

  const mainAdminHome = await request(app).get('/main-admin').set('Cookie', mainAdmin.cookie);
  assert.match(mainAdminHome.text, />Family School(?:<br\/?>| )Management</);
});

test('Main Admin Family School Management tab has Transcripts and Diplomas subpages, not a blank Settings page', async () => {
  // A real request: "Main admin portal. Family school management tab
  // should simply have two subpages. One for transcript creation and
  // one for diploma creation. Same pages and features as the family
  // school management portal for transcripts and diplomas." The old
  // blank placeholder was replaced entirely.
  const mainAdmin = await createPortalMember({ name: 'FSM Tab Admin', familyId: null, memberType: 'admin', roleKey: 'main_admin' });
  const transcripts = await request(app).get('/main-admin/family-school').set('Cookie', mainAdmin.cookie);
  assert.equal(transcripts.status, 200);
  assert.match(transcripts.text, /<h1>Transcripts<\/h1>/);
  assert.doesNotMatch(transcripts.text, /No settings here yet\./);

  const diplomas = await request(app).get('/main-admin/family-school/diplomas').set('Cookie', mainAdmin.cookie);
  assert.equal(diplomas.status, 200);
  assert.match(diplomas.text, /<h1>Diplomas<\/h1>/);
});

test('a parent can create a class, assign it to their own student, add a lesson with content, and the student sees it to work on and complete', async () => {
  const familyId = await createFamily('Full Flow Family');
  const parent = await createPortalMember({ name: 'Flow Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Flow Student', familyId, memberType: 'student', roleKey: 'student' });

  let csrf = await csrfFrom(parent.cookie, '/parent/family-school');
  const createClassRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ className: 'Homeschool Math', description: 'Arithmetic', _csrf: csrf });
  const classId = parseInt(createClassRes.headers.location.match(/classes\/(\d+)/)[1], 10);

  // Not assigned to any student yet - the class should not appear on
  // the student's own portal until explicitly assigned.
  const beforeAssign = await request(app).get('/student/family-school').set('Cookie', student.cookie);
  assert.doesNotMatch(beforeAssign.text, /Homeschool Math/);

  csrf = await csrfFrom(parent.cookie, `/parent/family-school/classes/${classId}`);
  await request(app)
    .post(`/parent/family-school/classes/${classId}/students`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentIds: String(student.memberId), _csrf: csrf });

  const afterAssign = await request(app).get('/student/family-school').set('Cookie', student.cookie);
  assert.match(afterAssign.text, /Homeschool Math/);

  const createLessonRes = await request(app)
    .post(`/parent/family-school/classes/${classId}/lessons`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ title: 'Addition', description: '', _csrf: csrf });
  const lessonId = parseInt(createLessonRes.headers.location.match(/lessons\/(\d+)/)[1], 10);

  await request(app)
    .post(`/parent/family-school/lessons/${lessonId}/content`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ type: 'text', title: 'Reading', body: 'Addition basics', _csrf: csrf });
  await request(app)
    .post(`/parent/family-school/lessons/${lessonId}/content`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ type: 'assignment_submission', title: 'Worksheet', submissionBody: '<p>Do the worksheet</p>', submissionPointsPossible: '10', _csrf: csrf });

  // A real request gave the class detail page the same Details/Lessons/
  // Grades tabs the co-op's own class detail page already has - the
  // lesson list (and its own completion count) now lives on the Lessons
  // tab, not the page's default ('details') landing tab.
  const studentClassPage = await request(app).get(`/student/family-school/classes/${classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.equal(studentClassPage.status, 200);
  assert.match(studentClassPage.text, /Addition/);
  assert.match(studentClassPage.text, /0\/2/, 'the lesson should show 0/2 completed before the student does anything');

  const textItem = await db.prepare("SELECT id FROM family_school_content_items WHERE lesson_id = ? AND type = 'text'").get(lessonId);
  const subItem = await db.prepare("SELECT id FROM family_school_content_items WHERE lesson_id = ? AND type = 'assignment_submission'").get(lessonId);

  const studentCsrf = await csrfFrom(student.cookie, `/student/family-school/content/${textItem.id}`);
  await request(app).post(`/student/family-school/content/${textItem.id}/complete`).set('Cookie', student.cookie).type('form').send({ _csrf: studentCsrf });

  const afterOneComplete = await request(app).get(`/student/family-school/classes/${classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.match(afterOneComplete.text, /1\/2/);

  // The submission-type item has no "complete" action - only a file
  // upload counts; the student always sees the upload form (canTakeQuiz
  // is always true on Student Portal), with no "Submitted" badge until
  // one actually exists.
  const subItemPage = await request(app).get(`/student/family-school/content/${subItem.id}`).set('Cookie', student.cookie);
  assert.match(subItemPage.text, /name="submissionFile"/);
  assert.doesNotMatch(subItemPage.text, /Submitted/);
});

test('a class/lesson/content item belonging to one family 404s for another family\'s parent (and does not leak into their own list)', async () => {
  const familyA = await createFamily('Isolation Family A');
  const parentA = await createPortalMember({ name: 'Isolation Parent A', familyId: familyA, memberType: 'parent', roleKey: 'parent' });
  let csrf = await csrfFrom(parentA.cookie, '/parent/family-school');
  const createRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ className: 'Family A Only Class', description: '', _csrf: csrf });
  const classId = parseInt(createRes.headers.location.match(/classes\/(\d+)/)[1], 10);

  const familyB = await createFamily('Isolation Family B');
  const parentB = await createPortalMember({ name: 'Isolation Parent B', familyId: familyB, memberType: 'parent', roleKey: 'parent' });

  const listPage = await request(app).get('/parent/family-school/classes').set('Cookie', parentB.cookie);
  assert.doesNotMatch(listPage.text, /Family A Only Class/);

  const manageRes = await request(app).get(`/parent/family-school/classes/${classId}`).set('Cookie', parentB.cookie);
  assert.equal(manageRes.status, 404);

  const csrfB = await csrfFrom(parentB.cookie, '/parent/family-school');
  const deleteAttempt = await request(app)
    .post(`/parent/family-school/classes/${classId}/delete`)
    .set('Cookie', parentB.cookie)
    .type('form')
    .send({ _csrf: csrfB });
  assert.equal(deleteAttempt.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_classes WHERE id = ?').get(classId), "family B's attempt must not have deleted family A's class");
});

test('a student can only see classes assigned to them, never another family\'s classes or an unassigned-to-them class in their own family', async () => {
  const familyId = await createFamily('Multi Student Family');
  const parent = await createPortalMember({ name: 'Multi Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Assigned Student', familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: 'Unassigned Student', familyId, memberType: 'student', roleKey: 'student' });

  let csrf = await csrfFrom(parent.cookie, '/parent/family-school');
  const createRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ className: 'Assigned Only Class', description: '', _csrf: csrf });
  const classId = parseInt(createRes.headers.location.match(/classes\/(\d+)/)[1], 10);
  await request(app)
    .post(`/parent/family-school/classes/${classId}/students`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentIds: String(studentA.memberId), _csrf: csrf });

  const studentAList = await request(app).get('/student/family-school').set('Cookie', studentA.cookie);
  assert.match(studentAList.text, /Assigned Only Class/);

  const studentBList = await request(app).get('/student/family-school').set('Cookie', studentB.cookie);
  assert.doesNotMatch(studentBList.text, /Assigned Only Class/);

  const studentBDirectAccess = await request(app).get(`/student/family-school/classes/${classId}`).set('Cookie', studentB.cookie);
  assert.equal(studentBDirectAccess.status, 404, "a student not assigned to the class can't view it by guessing the URL either");
});

test('Grades: a parent can grade a submitted assignment, and grading is scoped to their own family\'s students', async () => {
  const familyId = await createFamily('Grades Family');
  const parent = await createPortalMember({ name: 'Grades Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Grades Student', familyId, memberType: 'student', roleKey: 'student' });

  const { createClass, assignClassToStudents, createLesson, createContentItem, submitAssignment } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Grades Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Essay', pointsPossible: 20 });
  await submitAssignment({ contentItemId: itemId, studentId: student.memberId, fileUrl: 'key', fileName: 'essay.pdf' });

  const gradesPage = await request(app).get(`/parent/family-school/grades?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(gradesPage.status, 200);
  assert.match(gradesPage.text, /Essay/);
  const csrf = await csrfFrom(parent.cookie, `/parent/family-school/grades?studentId=${student.memberId}`);

  await request(app)
    .post(`/parent/family-school/grades/${itemId}/${student.memberId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ pointsEarned: '18', gradeLetter: 'A-', feedback: 'Nice work', _csrf: csrf });

  const row = await db.prepare('SELECT * FROM family_school_assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(itemId, student.memberId);
  assert.equal(row.status, 'graded');
  assert.equal(Number(row.points_earned), 18);
  assert.equal(row.grade_letter, 'A-');

  // Another family's parent can't grade this student's work even if they
  // guess the content item/student ids.
  const otherFamilyId = await createFamily('Other Grades Family');
  const otherParent = await createPortalMember({ name: 'Other Grades Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school');
  const hijackAttempt = await request(app)
    .post(`/parent/family-school/grades/${itemId}/${student.memberId}`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ pointsEarned: '0', gradeLetter: 'F', feedback: 'hijacked', _csrf: otherCsrf });
  assert.equal(hijackAttempt.status, 404);
  const unchanged = await db.prepare('SELECT grade_letter FROM family_school_assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(itemId, student.memberId);
  assert.equal(unchanged.grade_letter, 'A-', "another family's parent must not be able to overwrite this grade");
});

// A real request: "Family school management. Filter buttons should
// have student dropdown choice and school year choice." Same shape
// as the Daily Learning Log's own School Year filter test above,
// applied to Grades (bucketed by each content item's own due_date).
test('Grades: the Filter popover offers a School Year dropdown that filters grades, export, print, and PDF', async () => {
  const familyId = await createFamily('Grades School Year Family');
  const parent = await createPortalMember({ name: 'Grades Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Grades Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const { createClass, assignClassToStudents, createLesson, createContentItem } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Grades Year Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [student.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson', description: null, createdByAccountId: null });
  await createContentItem({ lessonId, type: 'assignment_submission', title: 'Fall Essay', pointsPossible: 20, dueDate: '2024-10-01' });
  await createContentItem({ lessonId, type: 'assignment_submission', title: 'Spring Essay', pointsPossible: 20, dueDate: '2026-04-02' });

  const allPage = await request(app).get(`/parent/family-school/grades?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(allPage.status, 200);
  assert.match(allPage.text, /<select id="grades-school-year-select" name="schoolYear" onchange="this\.form\.submit\(\)">/);
  assert.match(allPage.text, /<option value="all" selected>All Years<\/option>/);
  assert.match(allPage.text, /<option value="2024-2025"[^>]*>2024-2025<\/option>/);
  assert.match(allPage.text, /<option value="2025-2026"[^>]*>2025-2026<\/option>/);
  assert.match(allPage.text, /Fall Essay/);
  assert.match(allPage.text, /Spring Essay/);

  const filteredPage = await request(app).get(`/parent/family-school/grades?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.match(filteredPage.text, /<option value="2024-2025" selected>2024-2025<\/option>/);
  assert.match(filteredPage.text, /Fall Essay/);
  assert.doesNotMatch(filteredPage.text, /Spring Essay/);

  const filteredExport = await request(app).get(`/parent/family-school/grades/export.csv?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.match(filteredExport.text, /Fall Essay/);
  assert.doesNotMatch(filteredExport.text, /Spring Essay/);

  const filteredPrint = await request(app).get(`/parent/family-school/grades/print?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.equal(filteredPrint.status, 200);
  assert.match(filteredPrint.text, /Fall Essay/);
  assert.doesNotMatch(filteredPrint.text, /Spring Essay/);
});

test('Attendance: clicking a date cycles present (green) -> absent (red) -> unmarked, scoped to one student', async () => {
  const familyId = await createFamily('Attendance Family');
  const parent = await createPortalMember({ name: 'Attendance Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Attendance Student', familyId, memberType: 'student', roleKey: 'student' });

  const page = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&schoolYear=2025-2026`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  // A later real request ("it should show all 12 calendar months for
  // that school year") replaced the old single-month view with a
  // 12-month grid - see test/parent-family-attendance-layout.test.js
  // for full coverage of that; this test only needs to confirm March
  // 2026 (inside the 2025-2026 school year) actually renders.
  assert.match(page.text, /<h3>March 2026<\/h3>/);
  const csrf = await csrfFrom(parent.cookie, `/parent/family-school/attendance?studentId=${student.memberId}`);

  const toggle1 = await request(app).post(`/parent/family-school/attendance/${student.memberId}/toggle`).set('Cookie', parent.cookie).type('form').send({ date: '2026-03-10', _csrf: csrf });
  assert.deepEqual(toggle1.body, { ok: true, status: 'present' });

  const toggle2 = await request(app).post(`/parent/family-school/attendance/${student.memberId}/toggle`).set('Cookie', parent.cookie).type('form').send({ date: '2026-03-10', _csrf: csrf });
  assert.deepEqual(toggle2.body, { ok: true, status: 'absent' });

  const toggle3 = await request(app).post(`/parent/family-school/attendance/${student.memberId}/toggle`).set('Cookie', parent.cookie).type('form').send({ date: '2026-03-10', _csrf: csrf });
  assert.deepEqual(toggle3.body, { ok: true, status: null });
  assert.equal(await db.prepare('SELECT 1 FROM family_school_attendance WHERE student_id = ? AND attendance_date = ?').get(student.memberId, '2026-03-10'), undefined);

  // Another family's parent can't mark attendance for this student.
  const otherFamilyId = await createFamily('Other Attendance Family');
  const otherParent = await createPortalMember({ name: 'Other Attendance Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/attendance');
  const hijackAttempt = await request(app).post(`/parent/family-school/attendance/${student.memberId}/toggle`).set('Cookie', otherParent.cookie).type('form').send({ date: '2026-03-11', _csrf: otherCsrf });
  assert.equal(hijackAttempt.status, 404);
});

// A real request: "Family attendance should have a filter button to
// choose student, family and school year. When viewing student or
// family it should show all 12 calendar months for that school
// year." Picking a different School Year reloads the whole 12-month
// grid for that year instead of jumping a single month view.
test('Attendance: the Filter popover offers a School Year dropdown that reloads the whole 12-month grid for that year', async () => {
  const familyId = await createFamily('Attendance School Year Family');
  const parent = await createPortalMember({ name: 'Attendance Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Attendance Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const defaultPage = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(defaultPage.status, 200);
  assert.match(defaultPage.text, /<select id="attendance-school-year-select" name="schoolYear" onchange="this\.form\.submit\(\)">/);

  const jumped = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.equal(jumped.status, 200);
  assert.match(jumped.text, /<option value="2024-2025" selected>2024-2025<\/option>/);
  assert.match(jumped.text, /<h3>August 2024<\/h3>/);
  assert.match(jumped.text, /<h3>July 2025<\/h3>/);
  assert.doesNotMatch(jumped.text, /<h3>August 2023<\/h3>/);
});

test('Daily Learning Log (Teacher Journal): add an entry by date and student, it shows in the log below, and entries are scoped to one family', async () => {
  const familyId = await createFamily('Journal Family');
  const parent = await createPortalMember({ name: 'Journal Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Journal Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/journal');
  const createRes = await request(app)
    .post('/parent/family-school/journal')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(student.memberId), entryDate: '2026-04-02', body: '<p>Worked hard on fractions today.</p>', _csrf: csrf });
  assert.equal(createRes.status, 302);

  const logPage = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  // A real request: "Daily learning log, date format should be August
  // 12, 2026." - the raw YYYY-MM-DD database value is no longer shown.
  assert.match(logPage.text, /April 2, 2026/);
  assert.match(logPage.text, /Worked hard on fractions today\./);

  const entry = await db.prepare('SELECT id FROM family_school_journal_entries WHERE student_id = ?').get(student.memberId);

  const otherFamilyId = await createFamily('Other Journal Family');
  const otherParent = await createPortalMember({ name: 'Other Journal Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherLogPage = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}`).set('Cookie', otherParent.cookie);
  // studentId isn't the other parent's own, so the page silently falls
  // back to showing nothing for it rather than leaking the entry.
  assert.doesNotMatch(otherLogPage.text, /Worked hard on fractions today\./);

  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/family-school/journal');
  const deleteAttempt = await request(app)
    .post(`/parent/family-school/journal/${entry.id}/delete`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ _csrf: otherCsrf });
  assert.equal(deleteAttempt.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM family_school_journal_entries WHERE id = ?').get(entry.id), "another family's parent must not be able to delete this entry");
});

// A real request: "Daily learning log. Filter button should include
// choosing a school year." Entries are a past-dated log, so the year
// options come straight from the entries' own dates (Aug-Jul boundary,
// utils/familySchool.js's own schoolYearForDate) rather than a fixed
// forward-looking range.
test('Daily Learning Log: the Filter popover offers a School Year dropdown that filters the log, export, print, and PDF', async () => {
  const familyId = await createFamily('Journal School Year Family');
  const parent = await createPortalMember({ name: 'Journal Year Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Journal Year Student', familyId, memberType: 'student', roleKey: 'student' });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/journal');
  await request(app)
    .post('/parent/family-school/journal')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, entryDate: '2024-10-01', body: '<p>Fall year entry</p>', _csrf: csrf });
  await request(app)
    .post('/parent/family-school/journal')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, entryDate: '2026-04-02', body: '<p>Spring year entry</p>', _csrf: csrf });

  const allPage = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(allPage.status, 200);
  assert.match(allPage.text, /<select id="journal-school-year-select" name="schoolYear" onchange="this\.form\.submit\(\)">/);
  assert.match(allPage.text, /<option value="all" selected>All Years<\/option>/);
  assert.match(allPage.text, /<option value="2024-2025"[^>]*>2024-2025<\/option>/);
  assert.match(allPage.text, /<option value="2025-2026"[^>]*>2025-2026<\/option>/);
  assert.match(allPage.text, /Fall year entry/);
  assert.match(allPage.text, /Spring year entry/);

  const filteredPage = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.match(filteredPage.text, /<option value="2024-2025" selected>2024-2025<\/option>/);
  assert.match(filteredPage.text, /Fall year entry/);
  assert.doesNotMatch(filteredPage.text, /Spring year entry/);

  const filteredExport = await request(app).get(`/parent/family-school/journal/export.csv?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.match(filteredExport.text, /Fall year entry/);
  assert.doesNotMatch(filteredExport.text, /Spring year entry/);

  const filteredPrint = await request(app).get(`/parent/family-school/journal/print?studentId=${student.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.equal(filteredPrint.status, 200);
  assert.match(filteredPrint.text, /Fall year entry/);
  assert.doesNotMatch(filteredPrint.text, /Spring year entry/);
});

// "These classes are completely seperate from co-op classes and
// schedules as well as co-op teachers. It has nothing to do with that
// at all." - the whole Family School flow above never touches the
// co-op's own classes/class_staff/class_assignments tables; this just
// asserts that directly too, as a standing guarantee.
test('Family School classes never touch the co-op classes/class_staff/class_assignments tables', async () => {
  const beforeClasses = (await db.prepare('SELECT COUNT(*) AS n FROM classes').get()).n;
  const beforeStaff = (await db.prepare('SELECT COUNT(*) AS n FROM class_staff').get()).n;
  const beforeAssignments = (await db.prepare('SELECT COUNT(*) AS n FROM class_assignments').get()).n;

  const familyId = await createFamily('No Co-op Overlap Family');
  const parent = await createPortalMember({ name: 'No Overlap Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'No Overlap Student', familyId, memberType: 'student', roleKey: 'student' });
  let csrf = await csrfFrom(parent.cookie, '/parent/family-school');
  const createRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ className: 'No Overlap Class', description: '', _csrf: csrf });
  const classId = parseInt(createRes.headers.location.match(/classes\/(\d+)/)[1], 10);
  await request(app).post(`/parent/family-school/classes/${classId}/students`).set('Cookie', parent.cookie).type('form').send({ studentIds: String(student.memberId), _csrf: csrf });
  const lessonRes = await request(app).post(`/parent/family-school/classes/${classId}/lessons`).set('Cookie', parent.cookie).type('form').send({ title: 'No Overlap Lesson', description: '', _csrf: csrf });
  const lessonId = parseInt(lessonRes.headers.location.match(/lessons\/(\d+)/)[1], 10);
  await request(app).post(`/parent/family-school/lessons/${lessonId}/content`).set('Cookie', parent.cookie).type('form').send({ type: 'text', title: 'T', body: 'b', _csrf: csrf });

  const afterClasses = (await db.prepare('SELECT COUNT(*) AS n FROM classes').get()).n;
  const afterStaff = (await db.prepare('SELECT COUNT(*) AS n FROM class_staff').get()).n;
  const afterAssignments = (await db.prepare('SELECT COUNT(*) AS n FROM class_assignments').get()).n;
  assert.equal(afterClasses, beforeClasses, 'creating a Family School class must not create a co-op class');
  assert.equal(afterStaff, beforeStaff, 'must not create any co-op class_staff row');
  assert.equal(afterAssignments, beforeAssignments, 'must not create any co-op class_assignments row');
});

// A real request: "First subpage should be family school management.
// This page shows a card per kid. Each card shows the students name,
// grade level, list of family classes and their overall grade next to
// each class. Also over gpa based on current individual class grades...
// Each card also has the students profile picture from their profile.
// Each card also has a total count of attendance days from family
// management attendance per student. 1/180."
test('Overview: the bare /parent/family-school page shows a card per student with grade level, per-class grades, GPA, and attendance count', async () => {
  const familyId = await createFamily('Overview Family');
  const parent = await createPortalMember({ name: 'Overview Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const gradedStudent = await createPortalMember({ name: 'Overview Graded Student', familyId, memberType: 'student', roleKey: 'student' });
  await createPortalMember({ name: 'Overview Ungraded Student', familyId, memberType: 'student', roleKey: 'student' });
  await db.prepare('UPDATE members SET grade_level = ? WHERE id = ?').run('5th Grade', gradedStudent.memberId);

  const { createClass, assignClassToStudents, createLesson, createContentItem, submitAssignment, toggleAttendance } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Overview Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [gradedStudent.memberId]);
  const lessonId = await createLesson({ classId, title: 'Lesson', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Quiz', pointsPossible: 20 });
  await submitAssignment({ contentItemId: itemId, studentId: gradedStudent.memberId, fileUrl: 'key', fileName: 'quiz.pdf' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school');
  await request(app)
    .post(`/parent/family-school/grades/${itemId}/${gradedStudent.memberId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ pointsEarned: '18', gradeLetter: '', feedback: '', _csrf: csrf });

  await toggleAttendance(gradedStudent.memberId, '2026-03-01');
  await toggleAttendance(gradedStudent.memberId, '2026-03-02');
  await toggleAttendance(gradedStudent.memberId, '2026-03-03');

  const overview = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(overview.status, 200);
  assert.match(overview.text, /Family School Management/);

  assert.match(overview.text, /Overview Graded Student/);
  assert.match(overview.text, /5th Grade/);
  assert.match(overview.text, /Overview Class/);
  assert.match(overview.text, />A</, '18/20 = 90% rounds to an A letter grade next to the class');
  assert.match(overview.text, /4\.00/, 'a single graded class at an A (4.0 GPA points) averages to 4.00');
  assert.match(overview.text, /3\/180/, 'present-day count over the 180-day target');
  // A real request: "add a bar graph tracker to show percentage of 180
  // days completed." - 3/180 rounds to 2%.
  assert.match(overview.text, /fs-attendance-bar-fill" style="width: 2%;"/);
  assert.match(overview.text, /2% of 180 days/);

  assert.match(overview.text, /Overview Ungraded Student/);
  assert.match(overview.text, /0\/180/, 'a student with no attendance rows yet shows 0\\/180');
  assert.match(overview.text, /fs-attendance-bar-fill" style="width: 0%;"/);
  assert.match(overview.text, /No grade level set/);

  const otherFamilyId = await createFamily('Overview Other Family');
  const otherParent = await createPortalMember({ name: 'Overview Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherOverview = await request(app).get('/parent/family-school').set('Cookie', otherParent.cookie);
  assert.doesNotMatch(otherOverview.text, /Overview Graded Student/);
  assert.doesNotMatch(otherOverview.text, /Overview Class/);
});

// A real request: "Add the following buttons to each page. Export,
// print, download, filter." Export/Download are CSV downloads (Print is
// just window.print(), nothing server-side to test). A later real
// request ("remove filter button and feature") removed the Overview
// page's own Filter checkbox set entirely - every family student always
// shows now, and a further request ("remove blue page buttons") removed
// the old Family Classes/Grades/.../Portfolio quick-link row too (those
// pages are now direct top-level nav tabs instead - test/family-school-
// management.test.js's own nav test already covers that).
test('Overview: Export/Download CSV buttons cover the whole family, the old quick-link buttons are gone, and the school info header renders', async () => {
  const familyId = await createFamily('CSV Family');
  const parent = await createPortalMember({ name: 'CSV Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'CSV Student A', familyId, memberType: 'student', roleKey: 'student' });
  await createPortalMember({ name: 'CSV Student B', familyId, memberType: 'student', roleKey: 'student' });

  const { createClass, assignClassToStudents, saveFamilySchoolSettings } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'CSV Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [studentA.memberId]);
  await saveFamilySchoolSettings({ familyId, schoolName: 'The CSV Family Academy', ncHomeschoolId: '555555', homeschooledSince: '2026-08-23' });

  const summaryCsv = await request(app).get('/parent/family-school/export.csv').set('Cookie', parent.cookie);
  assert.equal(summaryCsv.status, 200);
  assert.match(summaryCsv.headers['content-type'], /text\/csv/);
  assert.match(summaryCsv.text, /CSV Student A/);
  assert.match(summaryCsv.text, /CSV Student B/);

  // A real follow-up request: "the download should be a pdf of exactly
  // how it would also look when printing" - Download is now a real PDF
  // (utils/pdfRender.js), not a CSV; see test/parent-family-school-
  // print-preview-and-pdf.test.js for coverage of what it actually
  // contains via that same data's -print.ejs preview page.
  const detailPdf = await request(app)
    .get('/parent/family-school/download.pdf')
    .set('Cookie', parent.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(detailPdf.status, 200);
  assert.equal(detailPdf.headers['content-type'], 'application/pdf');
  assert.equal(detailPdf.body.slice(0, 5).toString(), '%PDF-');

  const overview = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(overview.status, 200);
  // Both students show by default ("All Students" in the Filter's own
  // Student select - a later real request: "Filter buttons should
  // have student dropdown choice and school year choice" - brought the
  // Filter button itself back after it had been removed entirely).
  assert.match(overview.text, /class="fs-overview-name">CSV Student A</);
  assert.match(overview.text, /class="fs-overview-name">CSV Student B</);
  assert.match(overview.text, /<details class="filter-details" data-filter-details>/);
  assert.doesNotMatch(overview.text, /btn-secondary" href="\/parent\/family-school\/classes"/);

  // The new school-info header (school name/ID/homeschooled-since).
  assert.match(overview.text, /class="fs-school-header-name"[^>]*>The CSV Family Academy</);
  assert.match(overview.text, /NC Homeschool ID: 555555/);
  assert.match(overview.text, /Homeschooling since August 23, 2026/);
});

// A real request: "Family school management. Filter buttons should
// have student dropdown choice and school year choice." Overview's
// Filter had been removed entirely by an earlier request ("Remove
// filter button and feature") - it's back now with both choices:
// Student narrows which card(s) show, School Year narrows each
// shown card's own GPA/attendance (statsForStudent's own schoolYear).
test('Overview: the Filter popover offers Student and School Year dropdowns that narrow which cards show and their stats', async () => {
  const familyId = await createFamily('Overview Filter Family');
  const parent = await createPortalMember({ name: 'Overview Filter Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Overview Filter Student A', familyId, memberType: 'student', roleKey: 'student' });
  await createPortalMember({ name: 'Overview Filter Student B', familyId, memberType: 'student', roleKey: 'student' });

  const { toggleAttendance } = require('../utils/familySchool');
  await toggleAttendance(studentA.memberId, '2024-10-05');
  await toggleAttendance(studentA.memberId, '2026-04-05');

  const allPage = await request(app).get('/parent/family-school').set('Cookie', parent.cookie);
  assert.equal(allPage.status, 200);
  assert.match(allPage.text, /<select id="overview-student-select" name="studentId" onchange="this\.form\.submit\(\)">/);
  assert.match(allPage.text, /<option value="all" selected>All Students<\/option>/);
  assert.match(allPage.text, /class="fs-overview-name">Overview Filter Student A</);
  assert.match(allPage.text, /class="fs-overview-name">Overview Filter Student B</);
  assert.match(allPage.text, /2\/180/, 'both present days count with no year filter');

  const oneStudent = await request(app).get(`/parent/family-school?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.match(oneStudent.text, new RegExp(`<option value="${studentA.memberId}" selected>`));
  assert.match(oneStudent.text, /class="fs-overview-name">Overview Filter Student A</);
  assert.doesNotMatch(oneStudent.text, /class="fs-overview-name">Overview Filter Student B</);

  const oneYear = await request(app).get(`/parent/family-school?studentId=${studentA.memberId}&schoolYear=2024-2025`).set('Cookie', parent.cookie);
  assert.match(oneYear.text, /<option value="2024-2025" selected>2024-2025<\/option>/);
  assert.match(oneYear.text, /1\/180/, 'only the 2024-10-05 present day falls within 2024-2025');
});

test('Grades/Attendance/Journal: Export (one student) and Download (whole family) CSV buttons', async () => {
  const familyId = await createFamily('Export Family');
  const parent = await createPortalMember({ name: 'Export Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Export Student A', familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: 'Export Student B', familyId, memberType: 'student', roleKey: 'student' });

  const { createClass, assignClassToStudents, createLesson, createContentItem, submitAssignment, gradeAssignmentSubmission, toggleAttendance, createJournalEntry } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Export Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classId, [studentA.memberId, studentB.memberId]);
  const lessonId = await createLesson({ classId, title: 'Export Lesson', description: null, createdByAccountId: null });
  const itemId = await createContentItem({ lessonId, type: 'assignment_submission', title: 'Export Assignment', pointsPossible: 10 });
  await submitAssignment({ contentItemId: itemId, studentId: studentA.memberId, fileUrl: 'k', fileName: 'f.pdf' });
  await gradeAssignmentSubmission({ contentItemId: itemId, studentId: studentA.memberId, pointsEarned: 9, gradeLetter: 'A-', feedback: '' });
  await submitAssignment({ contentItemId: itemId, studentId: studentB.memberId, fileUrl: 'k', fileName: 'f.pdf' });
  await gradeAssignmentSubmission({ contentItemId: itemId, studentId: studentB.memberId, pointsEarned: 5, gradeLetter: 'F', feedback: '' });
  await toggleAttendance(studentA.memberId, '2026-04-01');
  await toggleAttendance(studentB.memberId, '2026-04-02');
  await createJournalEntry({ studentId: studentA.memberId, entryDate: '2026-04-01', body: '<p>Student A did great</p>', createdByAccountId: parent.accountId });
  await createJournalEntry({ studentId: studentB.memberId, entryDate: '2026-04-02', body: '<p>Student B did ok</p>', createdByAccountId: parent.accountId });

  // A real follow-up request: "the download should be a pdf of exactly
  // how it would also look when printing" - Download is now a real PDF
  // (utils/pdfRender.js) for all three pages, not a CSV; see test/
  // parent-family-school-print-preview-and-pdf.test.js for coverage of
  // what it actually contains via that same data's -print.ejs preview
  // page. getPdf here only confirms each Download route still produces
  // one, scoped to the whole family as before.
  async function getPdf(url, cookie) {
    return request(app)
      .get(url)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }

  const gradesExport = await request(app).get(`/parent/family-school/grades/export.csv?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.match(gradesExport.text, /Export Student A/);
  assert.doesNotMatch(gradesExport.text, /Export Student B/);
  const gradesDownload = await getPdf('/parent/family-school/grades/download.pdf', parent.cookie);
  assert.equal(gradesDownload.status, 200);
  assert.equal(gradesDownload.headers['content-type'], 'application/pdf');
  assert.equal(gradesDownload.body.slice(0, 5).toString(), '%PDF-');

  const attendanceExport = await request(app).get(`/parent/family-school/attendance/export.csv?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.match(attendanceExport.text, /2026-04-01/);
  assert.doesNotMatch(attendanceExport.text, /2026-04-02/);
  const attendanceDownload = await getPdf('/parent/family-school/attendance/download.pdf', parent.cookie);
  assert.equal(attendanceDownload.status, 200);
  assert.equal(attendanceDownload.headers['content-type'], 'application/pdf');
  assert.equal(attendanceDownload.body.slice(0, 5).toString(), '%PDF-');

  const journalExport = await request(app).get(`/parent/family-school/journal/export.csv?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.match(journalExport.text, /Student A did great/);
  assert.doesNotMatch(journalExport.text, /Student B did ok/);
  const journalDownload = await getPdf('/parent/family-school/journal/download.pdf', parent.cookie);
  assert.equal(journalDownload.status, 200);
  assert.equal(journalDownload.headers['content-type'], 'application/pdf');
  assert.equal(journalDownload.body.slice(0, 5).toString(), '%PDF-');

  // Scoped to this family only.
  const otherFamilyId = await createFamily('Export Other Family');
  const otherParent = await createPortalMember({ name: 'Export Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherGradesDownload = await getPdf('/parent/family-school/grades/download.pdf', otherParent.cookie);
  assert.equal(otherGradesDownload.status, 200);
  assert.equal(otherGradesDownload.body.slice(0, 5).toString(), '%PDF-');
});

// A real request: "Add a button that says +preplanned class" - "Pick
// from built-in curriculum templates."
// A real request: "Family school management. Filter buttons should
// have student dropdown choice and school year choice." Classes have
// no school-year field of their own (ongoing, not tied to a term) -
// just a Student choice, narrowing the card grid to classes that
// student is actually assigned to.
test('Family Classes: the Filter popover offers a Student dropdown that narrows the card grid to that student\'s own classes', async () => {
  const familyId = await createFamily('Classes Student Filter Family');
  const parent = await createPortalMember({ name: 'Classes Filter Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: 'Classes Filter Student A', familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: 'Classes Filter Student B', familyId, memberType: 'student', roleKey: 'student' });

  const { createClass, assignClassToStudents } = require('../utils/familySchool');
  const classAId = await createClass({ familyId, className: 'Student A Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classAId, [studentA.memberId]);
  const classBId = await createClass({ familyId, className: 'Student B Class', description: null, createdByAccountId: null });
  await assignClassToStudents(classBId, [studentB.memberId]);

  const allPage = await request(app).get('/parent/family-school/classes').set('Cookie', parent.cookie);
  assert.equal(allPage.status, 200);
  assert.match(allPage.text, /<select id="classes-student-select" name="studentId" onchange="this\.form\.submit\(\)">/);
  assert.match(allPage.text, /<option value="all" selected>All Students<\/option>/);
  assert.match(allPage.text, /Student A Class/);
  assert.match(allPage.text, /Student B Class/);

  const filteredPage = await request(app).get(`/parent/family-school/classes?studentId=${studentA.memberId}`).set('Cookie', parent.cookie);
  assert.match(filteredPage.text, new RegExp(`<option value="${studentA.memberId}" selected>`));
  assert.match(filteredPage.text, /Student A Class/);
  assert.doesNotMatch(filteredPage.text, /Student B Class/);
});

// A real request changed "+Preplanned Class" from a fixed built-in
// template set to pulling from the admin's own Lesson Plans library
// (only plans flagged allow_family_school_use), then moved that picker
// from a dropdown dialog onto its own "Available Lesson Plans" tab/
// subpage - "Available lesson plan tab should be a subpage under
// family classes." The "+ Preplanned Class" button is now a plain link
// into that tab, and each plan's own card has a Create Class button
// (no dropdown needed - the card itself is the pick).
test('Family Classes: the Available Lesson Plans tab lists only plans flagged for Homeschool family management, and its Create Class button creates a class with a linked lesson', async () => {
  const { createLessonPlan, updateLessonPlan } = require('../utils/lessonPlans');
  const familyId = await createFamily('Preplanned Class Family');
  const parent = await createPortalMember({ name: 'Preplanned Parent', familyId, memberType: 'parent', roleKey: 'parent' });

  const flaggedId = await createLessonPlan({ title: 'Fractions Unit', description: 'Core fractions skills.', createdByAccountId: null });
  await updateLessonPlan(flaggedId, { title: 'Fractions Unit', description: 'Core fractions skills.', allowFamilySchoolUse: true });
  const unflaggedId = await createLessonPlan({ title: 'Not Yet Shared', description: null, createdByAccountId: null });

  const classesPage = await request(app).get('/parent/family-school/classes').set('Cookie', parent.cookie);
  assert.equal(classesPage.status, 200);
  assert.match(classesPage.text, /href="\/parent\/family-school\/classes\?tab=availableLessonPlans">\+ Preplanned Class<\/a>/);
  assert.match(classesPage.text, /<a class="view-tab active" href="\/parent\/family-school\/classes">Family Classes<\/a>/);
  assert.doesNotMatch(classesPage.text, /Fractions Unit/, 'the lesson plan library listing must not render on the Family Classes tab itself');

  const libraryPage = await request(app).get('/parent/family-school/classes?tab=availableLessonPlans').set('Cookie', parent.cookie);
  assert.equal(libraryPage.status, 200);
  assert.match(libraryPage.text, /<a class="view-tab active" href="\/parent\/family-school\/classes\?tab=availableLessonPlans">Available Lesson Plans<\/a>/);
  assert.match(libraryPage.text, /Fractions Unit/);
  assert.doesNotMatch(libraryPage.text, /Not Yet Shared/);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/classes?tab=availableLessonPlans');
  const res = await request(app)
    .post('/parent/family-school/classes/from-lesson-plan')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ lessonPlanId: String(flaggedId), _csrf: csrf });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const classRow = await db.prepare("SELECT * FROM family_school_classes WHERE family_id = ? AND class_name = 'Fractions Unit'").get(familyId);
  assert.ok(classRow, 'expected a class named after the lesson plan');
  const lesson = await db.prepare('SELECT title, source_lesson_plan_id FROM family_school_lessons WHERE class_id = ?').get(classRow.id);
  assert.equal(lesson.title, 'Fractions Unit');
  assert.equal(lesson.source_lesson_plan_id, flaggedId);
  void unflaggedId;
});

// A real request: "Family school management, family classes. Mobile.
// Filter, add new class, add preplanned class buttons should be side
// by side in the same row. Shrink to fit." roster-btn-row-fit-text is
// the same shared mobile-shrink class every other page's own Filter+
// action-button row already uses.
test('Family Classes toolbar row carries roster-btn-row-fit-text for the mobile shrink-to-fit layout', async () => {
  const familyId = await createFamily('Classes Mobile Row Family');
  const parent = await createPortalMember({ name: 'Classes Mobile Row Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent/family-school/classes').set('Cookie', parent.cookie);
  assert.match(page.text, /<div class="roster-btn-row roster-btn-row-fit-text">/);
});

test('Family Classes: picking an unflagged (or unknown) lesson plan id is rejected without creating a class', async () => {
  const { createLessonPlan } = require('../utils/lessonPlans');
  const familyId = await createFamily('Preplanned Class Invalid Family');
  const parent = await createPortalMember({ name: 'Preplanned Invalid Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const unflaggedId = await createLessonPlan({ title: 'Unflagged Plan', description: null, createdByAccountId: null });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/classes');

  const res = await request(app)
    .post('/parent/family-school/classes/from-lesson-plan')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ lessonPlanId: String(unflaggedId), _csrf: csrf });
  assert.match(res.headers.location, /error=/);

  const bogus = await request(app)
    .post('/parent/family-school/classes/from-lesson-plan')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ lessonPlanId: '999999', _csrf: csrf });
  assert.match(bogus.headers.location, /error=/);

  const classCount = (await db.prepare('SELECT COUNT(*) AS n FROM family_school_classes WHERE family_id = ?').get(familyId)).n;
  assert.equal(Number(classCount), 0);
});

// A real request: "Lesson should appear on available lesson plans
// page" - the "+ New Lesson" dialog's own "Choose from Lesson Plans
// library" source (views/parent-family-school-class-manage.ejs) only
// lists, and only accepts, plans flagged allow_family_school_use.
test('New Lesson "Choose from Lesson Plans library" source only offers, and only accepts, plans flagged for Homeschool family management', async () => {
  const { createLessonPlan, updateLessonPlan } = require('../utils/lessonPlans');
  const { createClass } = require('../utils/familySchool');
  const familyId = await createFamily('Library Lesson Family');
  const parent = await createPortalMember({ name: 'Library Lesson Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const classId = await createClass({ familyId, className: 'Library Lesson Class', description: null, createdByAccountId: null });

  const flaggedId = await createLessonPlan({ title: 'Grammar Basics', description: null, createdByAccountId: null });
  await updateLessonPlan(flaggedId, { title: 'Grammar Basics', description: null, allowFamilySchoolUse: true });
  const unflaggedId = await createLessonPlan({ title: 'Not Shared Plan', description: null, createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/classes/${classId}`).set('Cookie', parent.cookie);
  assert.match(page.text, new RegExp(`<option value="${flaggedId}">Grammar Basics</option>`));
  assert.doesNotMatch(page.text, /Not Shared Plan/);

  const csrf = await csrfFrom(parent.cookie, `/parent/family-school/classes/${classId}`);
  const rejected = await request(app)
    .post(`/parent/family-school/classes/${classId}/lessons`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ source: 'plan', lessonPlanId: String(unflaggedId), _csrf: csrf });
  assert.match(rejected.headers.location, /error=/);

  const accepted = await request(app)
    .post(`/parent/family-school/classes/${classId}/lessons`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ source: 'plan', lessonPlanId: String(flaggedId), _csrf: csrf });
  assert.match(accepted.headers.location, /notice=/);
  const lesson = await db.prepare('SELECT title, source_lesson_plan_id FROM family_school_lessons WHERE class_id = ?').get(classId);
  assert.equal(lesson.title, 'Grammar Basics');
  assert.equal(lesson.source_lesson_plan_id, flaggedId);
});

// A real request: "Assignment/lessons should also show up under weekly
// planner add lessons" - an assignment-type content item on a lesson
// plan a Family Classes lesson references (source_lesson_plan_id) must
// appear in the "Add Class Assignment" dropdown, and picking it must
// actually save the assignment (content_item_id stays null since that
// column is a real foreign key into family_school_content_items only -
// see assignmentOptionsForFamily's own comment).
test('Weekly Planner "Add Class Assignment" dropdown includes an assignment from a referenced (flagged) lesson plan', async () => {
  const { createLessonPlan, updateLessonPlan } = require('../utils/lessonPlans');
  const { createLessonPlanContentItem } = require('../utils/lessonPlans');
  const { createClass, createLesson, createWeek } = require('../utils/familySchool');
  const familyId = await createFamily('Planner Library Family');
  const parent = await createPortalMember({ name: 'Planner Library Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Planner Library Student', familyId, memberType: 'student', roleKey: 'student' });

  const planId = await createLessonPlan({ title: 'Essay Plan', description: null, createdByAccountId: null });
  await updateLessonPlan(planId, { title: 'Essay Plan', description: null, allowFamilySchoolUse: true });
  await createLessonPlanContentItem({ lessonPlanId: planId, type: 'assignment_upload', title: 'Draft Essay' });

  const classId = await createClass({ familyId, className: 'Essay Class', description: null, createdByAccountId: null });
  await createLesson({ classId, title: 'Essay Plan', description: null, createdByAccountId: null, sourceLessonPlanId: planId });
  const weekId = await createWeek({ familyId, ownerType: 'student', studentId: student.memberId, title: 'Week 1', dates: ['2026-10-05'], createdByAccountId: null });
  const dateRow = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').get(weekId);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=${student.memberId}&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /Draft Essay/);
  const planOptionMatch = /<option value="(plan-\d+)">Essay Class &mdash; Draft Essay<\/option>/.exec(page.text);
  assert.ok(planOptionMatch, 'expected a plan- prefixed option for the referenced plan\'s assignment item');

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateRow.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ contentItemId: planOptionMatch[1], subject: '', title: '', _csrf: csrf });
  assert.equal(res.status, 302);
  const assignment = await db.prepare('SELECT * FROM family_school_week_assignments WHERE week_date_id = ?').get(dateRow.id);
  assert.equal(assignment.title, 'Draft Essay');
  assert.equal(assignment.subject, 'Essay Class');
  assert.equal(assignment.content_item_id, null, 'a plan-sourced pick must never write an invalid foreign key');
});

// A real request: "Content should say content/assignments. Button
// should say add new content/assignment."
test('Lesson Manage: the Content section is labeled Content/Assignments, with an Add New Content/Assignment button', async () => {
  const familyId = await createFamily('Content Label Family');
  const parent = await createPortalMember({ name: 'Content Label Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const { createClass, createLesson } = require('../utils/familySchool');
  const classId = await createClass({ familyId, className: 'Content Label Class', description: null, createdByAccountId: null });
  const lessonId = await createLesson({ classId, title: 'Content Label Lesson', description: null, createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/lessons/${lessonId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2>Content\/Assignments \(0\)<\/h2>/);
  assert.match(page.text, /\+ Add New Content\/Assignment/);
  assert.match(page.text, /<h3>Add New Content\/Assignment<\/h3>/);
});

// A real request: "Family school management pages, the buttons and
// icons should be well balanced and spaced between the page title and
// tables." The Filter/icons row most of these pages place right above
// their own table had 1.25rem of space above it (from .roster-toolbar's
// own h1 wrapper) but 0 below - .fs-toolbar-row-spaced adds that
// missing margin-bottom. Attendance gets the same treatment via its
// own already-scoped .fs-attendance-toolbar-row class instead (see
// test/parent-family-attendance-layout.test.js).
test('Grades/Volunteer Hours/Portfolio/Overview/Annual Planner: the Filter/icons row carries its own spacing before the table below it', async () => {
  const familyId = await createFamily('Toolbar Spacing Family');
  const parent = await createPortalMember({ name: 'Toolbar Spacing Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  await createPortalMember({ name: 'Toolbar Spacing Student', familyId, memberType: 'student', roleKey: 'student' });

  const pages = ['/parent/family-school/grades', '/parent/family-school/volunteer-hours', '/parent/family-school/portfolio', '/parent/family-school', '/parent/family-school/annual-planner'];
  for (const url of pages) {
    const res = await request(app).get(url).set('Cookie', parent.cookie);
    assert.equal(res.status, 200, `expected 200 from ${url}`);
    assert.match(res.text, /fs-toolbar-row-spaced/, `expected fs-toolbar-row-spaced on ${url}`);
  }
});

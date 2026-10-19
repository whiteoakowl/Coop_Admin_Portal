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

test('Family School Management nav tab appears on Parent, Student, and Main Admin portals', async () => {
  const familyId = await createFamily('Nav Family');
  const parent = await createPortalMember({ name: 'Nav Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Nav Student', familyId, memberType: 'student', roleKey: 'student' });
  const mainAdmin = await createPortalMember({ name: 'Nav Admin', familyId: null, memberType: 'admin', roleKey: 'main_admin' });

  const parentHome = await request(app).get('/parent').set('Cookie', parent.cookie);
  assert.match(parentHome.text, />Family School Management</);

  const studentHome = await request(app).get('/student').set('Cookie', student.cookie);
  assert.match(studentHome.text, />Family School Management</);

  const mainAdminHome = await request(app).get('/main-admin').set('Cookie', mainAdmin.cookie);
  assert.match(mainAdminHome.text, />Family School Management</);
});

test('Main Admin Family School Management tab is just a blank Settings page', async () => {
  const mainAdmin = await createPortalMember({ name: 'Blank Settings Admin', familyId: null, memberType: 'admin', roleKey: 'main_admin' });
  const page = await request(app).get('/main-admin/family-school').set('Cookie', mainAdmin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /No settings here yet\./);
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

  const studentClassPage = await request(app).get(`/student/family-school/classes/${classId}`).set('Cookie', student.cookie);
  assert.equal(studentClassPage.status, 200);
  assert.match(studentClassPage.text, /Addition/);
  assert.match(studentClassPage.text, /0\/2/, 'the lesson should show 0/2 completed before the student does anything');

  const textItem = await db.prepare("SELECT id FROM family_school_content_items WHERE lesson_id = ? AND type = 'text'").get(lessonId);
  const subItem = await db.prepare("SELECT id FROM family_school_content_items WHERE lesson_id = ? AND type = 'assignment_submission'").get(lessonId);

  const studentCsrf = await csrfFrom(student.cookie, `/student/family-school/content/${textItem.id}`);
  await request(app).post(`/student/family-school/content/${textItem.id}/complete`).set('Cookie', student.cookie).type('form').send({ _csrf: studentCsrf });

  const afterOneComplete = await request(app).get(`/student/family-school/classes/${classId}`).set('Cookie', student.cookie);
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

  const listPage = await request(app).get('/parent/family-school').set('Cookie', parentB.cookie);
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

test('Attendance: clicking a date cycles present (green) -> absent (red) -> unmarked, scoped to one student', async () => {
  const familyId = await createFamily('Attendance Family');
  const parent = await createPortalMember({ name: 'Attendance Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Attendance Student', familyId, memberType: 'student', roleKey: 'student' });

  const page = await request(app).get(`/parent/family-school/attendance?studentId=${student.memberId}&year=2026&month=3`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /March 2026/);
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

test('Teacher Journal: add an entry by date and student, it shows in the log below, and entries are scoped to one family', async () => {
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
  assert.match(logPage.text, /2026-04-02/);
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

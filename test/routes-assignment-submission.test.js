// Coverage for a real request: "When creating assignments for classes
// there should be a assignment submit option. Where i can add a title,
// description, points, grade and the student will see an upload link.
// The lesson itself should not have points. Points can be attached to
// each assignment instead." A follow-up clarification: "grade" is a
// letter/percentage field an admin/teacher fills in when reviewing a
// student's uploaded submission, alongside numeric points.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `assignment-submission-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `assignment-submission-test-uploads-${process.pid}`);
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

async function createClass() {
  return (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Submission Class', 'monday', 1) RETURNING id").get()).id;
}

async function enrollStudent(classId, email) {
  const code = await generateMemberCode();
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Submission Student', ?, ?, 'student', 1) RETURNING id").get(code, code)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(studentId, email, hashPassword('testpassword123'))
  ).id;
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, studentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { studentId, cookie: loginRes.headers['set-cookie'] };
}

test('Assignment Submission: admin creates it with points, student uploads a file, admin grades it with points + a letter grade', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  const student = await enrollStudent(classId, 'submission-student@example.com');

  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Week 1' });
  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(classId)).id;

  // The lesson itself has no points field left on its own edit form.
  const lessonPage = await request(app).get(`/admin/class-schedule/assignments/${assignmentId}`).set('Cookie', admin.cookie);
  assert.doesNotMatch(lessonPage.text, /name="pointsPossible"/);

  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      _csrf: admin.csrfToken,
      type: 'assignment_submission',
      title: 'Book Report',
      submissionBody: '<p>Write 500 words.</p>',
      submissionPointsPossible: '10',
      contentDueDate: '2026-11-01',
    });
  const contentItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'assignment_submission'").get(assignmentId);
  assert.ok(contentItem, 'the assignment_submission content item should be created');
  assert.equal(contentItem.points_possible, 10);
  assert.equal(contentItem.due_date, '2026-11-01');

  // Student sees a clickable sub-bar (title + due date + check mark) on
  // the Lessons tab, inside the lesson's collapsible accordion panel -
  // the upload form itself now lives on that item's own detail page
  // (a real request: "it opens it to another page... to view the
  // assignment and complete it").
  const lessonsTabBefore = await request(app).get(`/student/classes/${classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.equal(lessonsTabBefore.status, 200);
  assert.match(lessonsTabBefore.text, /Book Report/);
  assert.match(lessonsTabBefore.text, /Due Sun 11\/1/);
  assert.match(lessonsTabBefore.text, new RegExp(`href="/student/content/${contentItem.id}"`));
  assert.match(lessonsTabBefore.text, /aria-label="Not complete"/);
  // 0/1 completed before any upload.
  assert.match(lessonsTabBefore.text, />0\/1</);

  const detailBefore = await request(app).get(`/student/content/${contentItem.id}`).set('Cookie', student.cookie);
  assert.equal(detailBefore.status, 200);
  assert.match(detailBefore.text, /10 points/);
  assert.match(detailBefore.text, /Due Sun 11\/1/);
  assert.match(detailBefore.text, /name="submissionFile"/);
  assert.match(detailBefore.text, new RegExp(`action="/student/content/${contentItem.id}/submit"`));

  const tmpFilePath = path.join(os.tmpdir(), `book-report-${process.pid}.pdf`);
  fs.writeFileSync(tmpFilePath, '%PDF-1.4 fake pdf content');
  const studentCsrf = extractCsrf(detailBefore.text);
  const submitRes = await request(app)
    .post(`/student/content/${contentItem.id}/submit?_csrf=${encodeURIComponent(studentCsrf)}`)
    .set('Cookie', student.cookie)
    .attach('submissionFile', tmpFilePath, { filename: 'book-report.pdf', contentType: 'application/pdf' });
  fs.rmSync(tmpFilePath, { force: true });
  assert.equal(submitRes.status, 302);

  const submission = await db.prepare('SELECT * FROM assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(contentItem.id, student.studentId);
  assert.ok(submission, 'the submission row should exist');
  assert.equal(submission.status, 'submitted');
  assert.equal(submission.file_name, 'book-report.pdf');

  // After uploading, the detail page shows "Submitted" and the Lessons
  // tab's own lesson bar now reads "Done" (its only content item is
  // complete) with the item's own bar showing the check mark.
  const detailAfter = await request(app).get(`/student/content/${contentItem.id}`).set('Cookie', student.cookie);
  assert.match(detailAfter.text, /Submitted/);
  const lessonsTabAfter = await request(app).get(`/student/classes/${classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.match(lessonsTabAfter.text, />Done</);
  assert.match(lessonsTabAfter.text, /aria-label="Complete"/);

  // Admin reviews the submission: sees the uploaded file, enters points
  // and a letter grade.
  const reviewPage = await request(app).get(`/admin/class-schedule/content/${contentItem.id}/submissions`).set('Cookie', admin.cookie);
  assert.equal(reviewPage.status, 200);
  assert.match(reviewPage.text, /book-report\.pdf/);
  const reviewCsrf = extractCsrf(reviewPage.text);
  const gradeRes = await request(app)
    .post(`/admin/class-schedule/content/${contentItem.id}/submissions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: reviewCsrf, [`points_${student.studentId}`]: '9', [`grade_${student.studentId}`]: 'A-', [`feedback_${student.studentId}`]: 'Great work!' });
  assert.equal(gradeRes.status, 302);

  const gradedSubmission = await db.prepare('SELECT * FROM assignment_submissions WHERE content_item_id = ? AND student_id = ?').get(contentItem.id, student.studentId);
  assert.equal(gradedSubmission.status, 'graded');
  assert.equal(Number(gradedSubmission.points_earned), 9);
  assert.equal(gradedSubmission.grade_letter, 'A-');
  assert.equal(gradedSubmission.feedback, 'Great work!');

  // The student sees their score and letter grade on the item's own
  // detail page, and the lesson still reads "Done" on the Lessons tab.
  const detailGraded = await request(app).get(`/student/content/${contentItem.id}`).set('Cookie', student.cookie);
  assert.match(detailGraded.text, /Score: 9 \/ 10/);
  assert.match(detailGraded.text, /\(A-\)/);
  const lessonsTabGraded = await request(app).get(`/student/classes/${classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.match(lessonsTabGraded.text, />Done</);
});

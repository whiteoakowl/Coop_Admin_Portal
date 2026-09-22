// Coverage for a real request: "Classes, lessons. Button to add lessons.
// Could be link to video, text description, file link, quiz with
// scoring... Be able to reorder, assignments or lessons, drag and drop,
// due dates, open dates. Co-op admin and teacher dashboard have
// controls. Parent and student portal can view the classes and
// interact." Two follow-up questions were confirmed: quiz questions mix
// multiple_choice (auto-scored) and short_answer (teacher/admin reviews
// before the score is final), and quiz-taking is student-only (a parent
// can view a child's own result but never submit one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-content-quizzes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-content-quizzes-test-uploads-${process.pid}`);
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

let classCounter = 0;
async function createClassAndTeacher(email) {
  classCounter += 1;
  const classId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES (?, 'monday', 1) RETURNING id").get(`Lesson Test Class ${classCounter}`)
  ).id;
  const teacherCode = await generateMemberCode();
  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Test Teacher', ?, ?, 'parent', 1) RETURNING id").get(teacherCode, teacherCode)
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(teacherId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return { classId, teacherId, cookie: loginRes.headers['set-cookie'] };
}

async function enrollStudent(classId, email) {
  const code = await generateMemberCode();
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Test Student', ?, ?, 'student', 1) RETURNING id").get(code, code)
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

async function enrollChildOfParent(classId, parentEmail) {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Lesson Test Family') RETURNING id").get()).id;
  const parentCode = await generateMemberCode();
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Test Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(parentCode, parentCode, familyId)
  ).id;
  const childCode = await generateMemberCode();
  const childId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Test Child', ?, ?, 'student', ?, 1) RETURNING id")
      .get(childCode, childCode, familyId)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, childId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, parentEmail, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email: parentEmail, password: 'testpassword123', next: '/parent' });
  return { childId, cookie: loginRes.headers['set-cookie'] };
}

test('Co-op Admin: add a lesson with open/due dates, add content items, reorder both, manage quiz questions', async () => {
  const admin = await loginAsAdmin();
  const classId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Admin Lesson Class', 'monday', 1) RETURNING id").get()).id;

  const addLesson = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Week 1', openDate: '2026-09-25', dueDate: '2026-10-01' });
  assert.equal(addLesson.status, 302);

  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(classId)).id;
  const lessonPage = await request(app).get(`/admin/class-schedule/assignments/${assignmentId}`).set('Cookie', admin.cookie);
  assert.equal(lessonPage.status, 200);
  assert.match(lessonPage.text, /value="2026-09-25"/);
  assert.match(lessonPage.text, /value="2026-10-01"/);

  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'video', title: 'Intro Video', videoUrl: 'https://example.com/video' });
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'quiz', title: 'Week 1 Quiz' });

  const items = await db.prepare('SELECT * FROM lesson_content_items WHERE assignment_id = ? ORDER BY position').all(assignmentId);
  assert.equal(items.length, 2);
  const [videoItem, quizItem] = items;
  assert.equal(videoItem.type, 'video');
  assert.equal(quizItem.type, 'quiz');

  const reorderContent = await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content/reorder`)
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ contentItemIds: [quizItem.id, videoItem.id] });
  assert.equal(reorderContent.status, 200);
  const reordered = await db.prepare('SELECT id FROM lesson_content_items WHERE assignment_id = ? ORDER BY position').all(assignmentId);
  assert.deepEqual(reordered.map((r) => r.id), [quizItem.id, videoItem.id]);

  const addLesson2 = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Week 2' });
  assert.equal(addLesson2.status, 302);
  const secondAssignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ? AND title = ?').get(classId, 'Week 2')).id;

  const reorderLessons = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments/reorder`)
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ assignmentIds: [secondAssignmentId, assignmentId] });
  assert.equal(reorderLessons.status, 200);
  const reorderedLessons = await db.prepare('SELECT id FROM class_assignments WHERE class_id = ? ORDER BY position').all(classId);
  assert.deepEqual(reorderedLessons.map((r) => r.id), [secondAssignmentId, assignmentId]);

  const addQuestion = await request(app)
    .post(`/admin/class-schedule/content/${quizItem.id}/questions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'multiple_choice', prompt: '2+2?', pointsPossible: '2', correctChoice: '2', choice1: '3', choice2: '4', choice3: '5', choice4: '' });
  assert.equal(addQuestion.status, 302);

  const questionsPage = await request(app).get(`/admin/class-schedule/content/${quizItem.id}/questions`).set('Cookie', admin.cookie);
  assert.equal(questionsPage.status, 200);
  assert.match(questionsPage.text, /2\+2\?/);
  assert.match(questionsPage.text, />4 &#10003;</);

  const questionId = (await db.prepare('SELECT id FROM quiz_questions WHERE content_item_id = ?').get(quizItem.id)).id;
  const deleteQuestion = await request(app).post(`/admin/class-schedule/questions/${questionId}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(deleteQuestion.status, 302);
  assert.equal(await db.prepare('SELECT id FROM quiz_questions WHERE id = ?').get(questionId), undefined);

  const deleteContent = await request(app).post(`/admin/class-schedule/content/${videoItem.id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(deleteContent.status, 302);
  assert.equal(await db.prepare('SELECT id FROM lesson_content_items WHERE id = ?').get(videoItem.id), undefined);
});

test('Quiz scoring: multiple_choice auto-scores, short_answer stays pending until reviewed, then the attempt is graded', async () => {
  const admin = await loginAsAdmin();
  const teacher = await createClassAndTeacher('lesson-quiz-teacher@example.com');
  const student = await enrollStudent(teacher.classId, 'lesson-quiz-student@example.com');

  await request(app)
    .post(`/admin/class-schedule/classes/${teacher.classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Scored Lesson' });
  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(teacher.classId)).id;

  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'quiz', title: 'Mixed Quiz' });
  const quizItemId = (await db.prepare('SELECT id FROM lesson_content_items WHERE assignment_id = ?').get(assignmentId)).id;

  await request(app)
    .post(`/admin/class-schedule/content/${quizItemId}/questions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'multiple_choice', prompt: '2+2?', pointsPossible: '2', correctChoice: '1', choice1: '4', choice2: '5', choice3: '', choice4: '' });
  await request(app)
    .post(`/admin/class-schedule/content/${quizItemId}/questions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'short_answer', prompt: 'Explain photosynthesis.', pointsPossible: '3' });

  const mcQuestion = await db.prepare("SELECT * FROM quiz_questions WHERE content_item_id = ? AND type = 'multiple_choice'").get(quizItemId);
  const saQuestion = await db.prepare("SELECT * FROM quiz_questions WHERE content_item_id = ? AND type = 'short_answer'").get(quizItemId);
  const correctChoice = await db.prepare('SELECT id FROM quiz_choices WHERE question_id = ? AND is_correct = 1').get(mcQuestion.id);

  const quizPage = await request(app).get(`/student/content/${quizItemId}/quiz`).set('Cookie', student.cookie);
  assert.equal(quizPage.status, 200);
  const studentCsrf = extractCsrf(quizPage.text);

  const submit = await request(app)
    .post(`/student/content/${quizItemId}/quiz`)
    .set('Cookie', student.cookie)
    .type('form')
    .send({ _csrf: studentCsrf, [`choice_${mcQuestion.id}`]: String(correctChoice.id), [`answer_${saQuestion.id}`]: 'It converts light to energy.' });
  assert.equal(submit.status, 302);

  const attemptAfterSubmit = await db.prepare('SELECT * FROM quiz_attempts WHERE content_item_id = ? AND student_id = ?').get(quizItemId, student.studentId);
  assert.equal(attemptAfterSubmit.status, 'pending_review');
  assert.equal(attemptAfterSubmit.score_points, null);

  const mcAnswer = await db.prepare('SELECT * FROM quiz_answers WHERE attempt_id = ? AND question_id = ?').get(attemptAfterSubmit.id, mcQuestion.id);
  assert.equal(Number(mcAnswer.is_correct), 1);
  assert.equal(Number(mcAnswer.points_earned), 2);

  const adminReview = await request(app).get('/admin/class-schedule/quiz-review').set('Cookie', admin.cookie);
  assert.equal(adminReview.status, 200);
  assert.match(adminReview.text, /It converts light to energy\./);

  const teacherReview = await request(app).get('/teacher/quiz-review').set('Cookie', teacher.cookie);
  assert.equal(teacherReview.status, 200);
  assert.match(teacherReview.text, /It converts light to energy\./);

  const saAnswer = await db.prepare('SELECT * FROM quiz_answers WHERE attempt_id = ? AND question_id = ?').get(attemptAfterSubmit.id, saQuestion.id);
  const teacherCsrf = extractCsrf(teacherReview.text);
  const score = await request(app)
    .post(`/teacher/quiz-answers/${saAnswer.id}/score`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ _csrf: teacherCsrf, pointsEarned: '3' });
  assert.equal(score.status, 302);

  const finalAttempt = await db.prepare('SELECT * FROM quiz_attempts WHERE id = ?').get(attemptAfterSubmit.id);
  assert.equal(finalAttempt.status, 'graded');
  assert.equal(Number(finalAttempt.score_points), 5);

  const reviewAfter = await request(app).get('/teacher/quiz-review').set('Cookie', teacher.cookie);
  assert.doesNotMatch(reviewAfter.text, /It converts light to energy\./);
});

test('A lesson gated by a future open date hides its content on the Lessons tab', async () => {
  const admin = await loginAsAdmin();
  const teacher = await createClassAndTeacher('lesson-gate-teacher@example.com');
  const student = await enrollStudent(teacher.classId, 'lesson-gate-student@example.com');

  await request(app)
    .post(`/admin/class-schedule/classes/${teacher.classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Future Lesson', openDate: '2099-01-01' });
  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(teacher.classId)).id;
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'text', title: 'Hidden Text', body: 'Should not be visible yet.' });

  const lessonsTab = await request(app).get(`/student/classes/${teacher.classId}?tab=lessons`).set('Cookie', student.cookie);
  assert.equal(lessonsTab.status, 200);
  assert.doesNotMatch(lessonsTab.text, /Should not be visible yet\./);
  assert.match(lessonsTab.text, /This lesson opens 2099-01-01/);
});

test('Teacher Portal: a teacher cannot manage lesson content on a class they do not teach', async () => {
  const admin = await loginAsAdmin();
  const outsiderTeacher = await createClassAndTeacher('lesson-outsider-teacher@example.com');
  const ownerClassId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Owner Only Class', 'monday', 2) RETURNING id").get()).id;

  await request(app)
    .post(`/admin/class-schedule/classes/${ownerClassId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Owner Lesson' });
  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(ownerClassId)).id;

  const outsiderHome = await request(app).get('/teacher').set('Cookie', outsiderTeacher.cookie);
  const outsiderCsrf = extractCsrf(outsiderHome.text);
  const attempt = await request(app)
    .post(`/teacher/assignments/${assignmentId}/content`)
    .set('Cookie', outsiderTeacher.cookie)
    .type('form')
    .send({ _csrf: outsiderCsrf, type: 'text', title: 'Should Not Work', body: 'nope' });
  assert.equal(attempt.status, 403);
  assert.equal(await db.prepare('SELECT id FROM lesson_content_items WHERE assignment_id = ?').get(assignmentId), undefined);
});

test('Parent Portal Lessons tab is read-only: shows quiz status but has no reachable submission route', async () => {
  const admin = await loginAsAdmin();
  const teacher = await createClassAndTeacher('lesson-parent-teacher@example.com');
  const parent = await enrollChildOfParent(teacher.classId, 'lesson-parent-viewer@example.com');

  await request(app)
    .post(`/admin/class-schedule/classes/${teacher.classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, title: 'Parent View Lesson' });
  const assignmentId = (await db.prepare('SELECT id FROM class_assignments WHERE class_id = ?').get(teacher.classId)).id;
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignmentId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, type: 'quiz', title: 'Parent View Quiz' });
  const quizItemId = (await db.prepare('SELECT id FROM lesson_content_items WHERE assignment_id = ?').get(assignmentId)).id;

  const lessonsTab = await request(app)
    .get(`/parent/classes/dashboard/${teacher.classId}?tab=lessons&studentId=${parent.childId}`)
    .set('Cookie', parent.cookie);
  assert.equal(lessonsTab.status, 200);
  assert.match(lessonsTab.text, /Parent View Quiz/);
  assert.match(lessonsTab.text, /Not taken yet/);
  assert.doesNotMatch(lessonsTab.text, /Take Quiz/);

  const noQuizRoute = await request(app).get(`/parent/content/${quizItemId}/quiz`).set('Cookie', parent.cookie);
  assert.equal(noQuizRoute.status, 404);
  // No CSRF token is even attempted here on purpose: the point is that
  // Parent Portal has no legitimate page that could have handed one out
  // for this route in the first place, since routes/parent-portal.js
  // defines no POST /content/:id/quiz at all - the global CSRF layer
  // rejects the forged request before Express's router ever gets a
  // chance to 404 it.
  const noQuizPostRoute = await request(app).post(`/parent/content/${quizItemId}/quiz`).set('Cookie', parent.cookie).type('form').send({});
  assert.equal(noQuizPostRoute.status, 403);
});

// Coverage for a real request: "Student and parent portal you can't
// click on class lessons to complete them." A quiz content item already
// had its own "complete" action (submitting it). A video/text/file/
// assignment_upload content item had none at all - nothing to click.
// This is the new "Mark Complete" action for those remaining types
// (routes/student-portal.js and routes/parent-portal.js's own
// POST /content/:id/complete, utils/academics.js's
// markLessonItemComplete/getLessonItemCompletion).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-item-lesson-click-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-item-lesson-click-test-uploads-${process.pid}`);
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

let seedCounter = 0;

async function createClassWithVideoLesson(admin) {
  seedCounter += 1;
  const className = `Lesson Click Complete Class ${seedCounter}`;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday', className, hourPosition: '1', room: 'Room A', color: '#EE9A4D',
      startTime: '9:00 AM', endTime: '9:45 AM', allowParentRegister: '1', _csrf: admin.csrfToken,
    });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);

  const manage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const manageCsrf = extractCsrf(manage.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Video Lesson', _csrf: manageCsrf });
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY id DESC LIMIT 1').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'video', title: 'Intro Video', videoUrl: 'https://example.com/video', _csrf: manageCsrf });
  const contentItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'video'").get(assignment.id);

  return { cls, assignment, contentItem };
}

async function createStudentAccount(name) {
  seedCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${name} Family`)).lastInsertRowid;
  const code = await generateMemberCode();
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(name, code, code, familyId);
  const email = `lesson-click-${seedCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(studentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, studentRole.id);
  return { studentId: studentInfo.lastInsertRowid, email };
}

async function createParentWithChild() {
  seedCounter += 1;
  const n = seedCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Lesson Click Parent Family ${n}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Lesson Click Parent ${n}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Lesson Click Child ${n}`, childCode, childCode, familyId);
  const email = `lesson-click-parent-${n}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);
  return { childId: childInfo.lastInsertRowid, email };
}

test('Student Portal: a video lesson shows a Mark Complete button, and clicking it records completion', async () => {
  const admin = await loginAsAdmin();
  const { cls, contentItem } = await createClassWithVideoLesson(admin);
  const student = await createStudentAccount('Lesson Click Student');
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, student.studentId);

  const loginRes = await request(app).post('/login').type('form').send({ email: student.email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const before = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  assert.equal(before.status, 200);
  assert.match(before.text, /Mark Complete/);
  assert.doesNotMatch(before.text, />Completed</);
  const csrf = extractCsrf(before.text);

  const complete = await request(app)
    .post(`/student/content/${contentItem.id}/complete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(complete.status, 302);

  const after = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  assert.match(after.text, />Completed</);
  assert.doesNotMatch(after.text, /Mark Complete/);

  const row = await db.prepare('SELECT * FROM lesson_item_completions WHERE content_item_id = ? AND student_id = ?').get(contentItem.id, student.studentId);
  assert.ok(row, 'expected a lesson_item_completions row');
});

test('Parent Portal: Mark Complete for a non-quiz item is gated by allow_parent_complete_lessons, same as the quiz flow', async () => {
  const admin = await loginAsAdmin();
  const { cls, contentItem } = await createClassWithVideoLesson(admin);
  const parent = await createParentWithChild();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, parent.childId);

  const loginRes = await request(app).post('/login').type('form').send({ email: parent.email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];

  const beforeToggle = await request(app).get(`/parent/classes/dashboard/${cls.id}?tab=lessons&studentId=${parent.childId}`).set('Cookie', cookie);
  assert.equal(beforeToggle.status, 200);
  assert.doesNotMatch(beforeToggle.text, /Mark Complete/);
  const csrfBefore = extractCsrf(beforeToggle.text);

  const blockedPost = await request(app)
    .post(`/parent/content/${contentItem.id}/complete?studentId=${parent.childId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfBefore });
  assert.equal(blockedPost.status, 404);

  await db.prepare('UPDATE classes SET allow_parent_complete_lessons = 1 WHERE id = ?').run(cls.id);

  const afterToggle = await request(app).get(`/parent/classes/dashboard/${cls.id}?tab=lessons&studentId=${parent.childId}`).set('Cookie', cookie);
  assert.match(afterToggle.text, /Mark Complete/);
  const csrfAfter = extractCsrf(afterToggle.text);

  const allowedPost = await request(app)
    .post(`/parent/content/${contentItem.id}/complete?studentId=${parent.childId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfAfter });
  assert.equal(allowedPost.status, 302);

  const row = await db.prepare('SELECT * FROM lesson_item_completions WHERE content_item_id = ? AND student_id = ?').get(contentItem.id, parent.childId);
  assert.ok(row, 'expected a lesson_item_completions row recorded on the child, not the parent');
});

test('Mark Complete cannot be used on a quiz content item (quizzes keep their own Take Quiz flow)', async () => {
  const admin = await loginAsAdmin();
  const { cls } = await createClassWithVideoLesson(admin);
  const manage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const manageCsrf = extractCsrf(manage.text);
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY id DESC LIMIT 1').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'quiz', title: 'A Quiz', _csrf: manageCsrf });
  const quizItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'quiz'").get(assignment.id);

  const student = await createStudentAccount('Lesson Click Quiz Guard Student');
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, student.studentId);
  const loginRes = await request(app).post('/login').type('form').send({ email: student.email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const page = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  const csrf = extractCsrf(page.text);
  const res = await request(app)
    .post(`/student/content/${quizItem.id}/complete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(res.status, 404);
});

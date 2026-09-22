// Coverage for two real requests:
// 1. "Add to class settings, check boxes, allow parents to complete
//    lessons for student and allow parent to interact in the class chat.
//    This way it can be turned on or off for different classes."
// 2. "Class page filter drop down. Filter button, grade level, hour, day,
//    full, for co-op admin. Parents can filter classes by grade level and
//    by their own students, drop down menu. If filtering by their
//    student it will only show classes that matching their grade level."
//    (a follow-up dropped "day" - Monday/Wednesday are already separate
//    tabs - and moved every filter into one "Filter" button/dropdown).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-parent-perms-filters-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-parent-perms-filters-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const academics = require('../utils/academics');
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

async function setClassSetting(admin, classId, field, value) {
  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, field, value });
  assert.equal(res.status, 200);
}

let familyCounter = 0;
async function createParentWithChild(classId, childGradeLevel) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Perms Filters Family ${familyCounter}`)).id;
  const parentCode = await generateMemberCode();
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Perms Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(parentCode, parentCode, familyId)
  ).id;
  const childCode = await generateMemberCode();
  const childId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, grade_level) VALUES ('Perms Child', ?, ?, 'student', ?, 1, ?) RETURNING id")
      .get(childCode, childCode, familyId, childGradeLevel || null)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, childId);
  const email = `perms-parent-${familyCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, email, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { parentId, childId, cookie: loginRes.headers['set-cookie'] };
}

test('Class Settings tab: allowParentCompleteLessons and allowParentChat toggle independently and persist', async () => {
  const admin = await loginAsAdmin();
  const classId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Perms Toggle Class', 'monday', 1) RETURNING id").get()).id;

  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.match(page.text, /allowParentCompleteLessons/);
  assert.match(page.text, /allowParentChat/);

  await setClassSetting(admin, classId, 'allowParentCompleteLessons', '1');
  let row = await db.prepare('SELECT allow_parent_complete_lessons, allow_parent_chat FROM classes WHERE id = ?').get(classId);
  assert.equal(Number(row.allow_parent_complete_lessons), 1);
  assert.equal(Number(row.allow_parent_chat), 0);

  await setClassSetting(admin, classId, 'allowParentChat', '1');
  row = await db.prepare('SELECT allow_parent_complete_lessons, allow_parent_chat FROM classes WHERE id = ?').get(classId);
  assert.equal(Number(row.allow_parent_complete_lessons), 1);
  assert.equal(Number(row.allow_parent_chat), 1);
});

test('Parent Portal Chat tab: hidden and unreachable until allow_parent_chat is on, then works and is visible to Co-op Admin too', async () => {
  const admin = await loginAsAdmin();
  const classId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Perms Chat Class', 'monday', 1) RETURNING id").get()).id;
  const parent = await createParentWithChild(classId);

  const before = await request(app).get(`/parent/classes/dashboard/${classId}?tab=chat&studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(before.status, 200);
  assert.doesNotMatch(before.text, /tab=chat/);
  const csrf = extractCsrf(before.text);
  const postBefore = await request(app)
    .post(`/parent/classes/dashboard/${classId}/chat?studentId=${parent.childId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, body: 'too early' });
  assert.equal(postBefore.status, 404);

  await setClassSetting(admin, classId, 'allowParentChat', '1');

  const after = await request(app).get(`/parent/classes/dashboard/${classId}?tab=chat&studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.match(after.text, /tab=chat/);
  const post = await request(app)
    .post(`/parent/classes/dashboard/${classId}/chat?studentId=${parent.childId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, body: 'Hello from a parent' });
  assert.equal(post.status, 302);

  const final = await request(app).get(`/parent/classes/dashboard/${classId}?tab=chat&studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.match(final.text, /Hello from a parent/);
  assert.match(final.text, /Perms Parent/);

  const adminChat = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=chat`).set('Cookie', admin.cookie);
  assert.match(adminChat.text, /Hello from a parent/);
  assert.match(adminChat.text, /Perms Parent/);
});

test('Parent Portal quiz completion: hidden/unreachable until allow_parent_complete_lessons is on, then a parent can submit for their child', async () => {
  const admin = await loginAsAdmin();
  const classId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Perms Quiz Class', 'monday', 1) RETURNING id").get()).id;
  const parent = await createParentWithChild(classId);

  const assignmentId = await academics.createAssignment({ classId, className: 'Perms Quiz Class', title: 'Lesson', createdByAccountId: null });
  const quizItemId = await academics.createContentItem({ assignmentId, type: 'quiz', title: 'Parent Quiz' });
  const mcId = await academics.createQuizQuestion({
    contentItemId: quizItemId,
    type: 'multiple_choice',
    prompt: '2+2?',
    pointsPossible: 2,
    choices: [{ label: '3', isCorrect: false }, { label: '4', isCorrect: true }],
  });

  const before = await request(app).get(`/parent/content/${quizItemId}/quiz?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(before.status, 404);
  const lessonsBefore = await request(app).get(`/parent/classes/dashboard/${classId}?tab=lessons&studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(lessonsBefore.text, /Take Quiz/);
  assert.match(lessonsBefore.text, /Not taken yet/);

  await setClassSetting(admin, classId, 'allowParentCompleteLessons', '1');

  const lessonsAfter = await request(app).get(`/parent/classes/dashboard/${classId}?tab=lessons&studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.match(lessonsAfter.text, /Take Quiz/);

  const quizPage = await request(app).get(`/parent/content/${quizItemId}/quiz?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(quizPage.status, 200);
  const csrf = extractCsrf(quizPage.text);
  const correctChoice = await db.prepare('SELECT id FROM quiz_choices WHERE question_id = ? AND is_correct = 1').get(mcId);

  const submit = await request(app)
    .post(`/parent/content/${quizItemId}/quiz?studentId=${parent.childId}`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf, [`choice_${mcId}`]: String(correctChoice.id) });
  assert.equal(submit.status, 302);

  const attempt = await db.prepare('SELECT * FROM quiz_attempts WHERE content_item_id = ? AND student_id = ?').get(quizItemId, parent.childId);
  assert.equal(attempt.status, 'graded');
  assert.equal(Number(attempt.score_points), 2);
});

test('Co-op Admin Class page: Filter button consolidates Date/Hour/Grade Level/Full, no separate Day field', async () => {
  const admin = await loginAsAdmin();
  const fullClassId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position, age_group, capacity) VALUES ('Filter Full Class', 'monday', 1, '1st', 1) RETURNING id").get()
  ).id;
  const studentCode = await generateMemberCode();
  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Filter Fill Student', ?, ?, 'student', 1) RETURNING id").get(studentCode, studentCode)).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(fullClassId, studentId);
  const openClassId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position, age_group, capacity) VALUES ('Filter Open Class', 'monday', 1, '2nd', 5) RETURNING id").get()
  ).id;

  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-filter-details/);
  assert.match(page.text, />Filter</);
  assert.match(page.text, /data-class-schedule-grade-filter/);
  assert.match(page.text, /data-class-schedule-full-filter/);
  assert.match(page.text, /data-class-schedule-hour-filter/);
  assert.doesNotMatch(page.text, /data-class-schedule-day-filter/);

  assert.match(page.text, /data-class-full="1"/);
  assert.match(page.text, /data-class-grade-list="1st"/);
  assert.match(page.text, /data-class-grade-list="2nd"/);

  const openRow = await db.prepare('SELECT id FROM classes WHERE id = ?').get(openClassId);
  assert.ok(openRow);
});

test('Parent Portal Class Registration page: Filter button offers Grade Level + My Student, student option carries their grade', async () => {
  const gradeClassId = (await db.prepare("INSERT INTO classes (class_name, day, hour_position, age_group) VALUES ('Parent Filter Class', 'monday', 1, '3rd') RETURNING id").get()).id;
  const parent = await createParentWithChild(gradeClassId, '3rd');

  const page = await request(app).get('/parent/classes?day=monday').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-filter-details/);
  assert.match(page.text, /data-parent-class-student-filter/);
  assert.match(page.text, /data-parent-class-grade-filter/);
  assert.match(page.text, /data-grade="3rd"/);
  assert.match(page.text, /data-class-grade-list="3rd"/);
});

// Coverage for a real request: "If no dates are added, it still won't
// let you go to the next lesson until the first one is complete. Add
// lock and unlock icon ... for when its open to complete." Neither
// lesson here gets an open_date, so this exercises the NEW rule on its
// own, separate from the pre-existing open_date gate
// (routes-lesson-content-quizzes.test.js already covers that one) -
// utils/academics.js's own lessonsForStudentView/isLessonLockedForStudent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-sequential-lock-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-sequential-lock-test-uploads-${process.pid}`);
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

test('A class with two dateless lessons locks the second until the first is fully complete', async () => {
  const admin = await loginAsAdmin();
  seedCounter += 1;
  const className = `Sequential Lock Class ${seedCounter}`;
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

  // Neither lesson gets an open_date - the "no dates added" case.
  await request(app).post(`/admin/class-schedule/classes/${cls.id}/assignments`).set('Cookie', admin.cookie).type('form').send({ title: 'Lesson One', _csrf: manageCsrf });
  const lessonOne = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY position ASC LIMIT 1').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${lessonOne.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'video', title: 'Lesson One Video', videoUrl: 'https://example.com/video-one', _csrf: manageCsrf });
  const itemOne = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'video'").get(lessonOne.id);

  await request(app).post(`/admin/class-schedule/classes/${cls.id}/assignments`).set('Cookie', admin.cookie).type('form').send({ title: 'Lesson Two', _csrf: manageCsrf });
  const lessonTwo = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? ORDER BY position DESC LIMIT 1').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${lessonTwo.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'video', title: 'Lesson Two Video', videoUrl: 'https://example.com/video-two', _csrf: manageCsrf });
  const itemTwo = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'video'").get(lessonTwo.id);

  seedCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Sequential Lock Family ${seedCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run('Sequential Lock Student', code, code, familyId);
  const studentId = studentInfo.lastInsertRowid;
  const email = `sequential-lock-${seedCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(studentId, email, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, studentRole.id);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, studentId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const lessonsBefore = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  assert.equal(lessonsBefore.status, 200);
  // Lesson One: open (unlock icon), its content item bar is a real link.
  assert.match(lessonsBefore.text, /aria-label="Open to complete"/);
  assert.match(lessonsBefore.text, new RegExp(`href="/student/content/${itemOne.id}"`));
  // Lesson Two: locked (lock icon), hint shown, no link to its own item.
  assert.match(lessonsBefore.text, /aria-label="Locked"/);
  assert.match(lessonsBefore.text, /Complete the previous lesson to unlock/);
  assert.doesNotMatch(lessonsBefore.text, new RegExp(`href="/student/content/${itemTwo.id}"`));

  // Direct URL access to the still-locked lesson's own content item 404s -
  // this isn't just a hidden link, it's actually blocked.
  const blockedGet = await request(app).get(`/student/content/${itemTwo.id}`).set('Cookie', cookie);
  assert.equal(blockedGet.status, 404);

  const itemOnePage = await request(app).get(`/student/content/${itemOne.id}`).set('Cookie', cookie);
  assert.equal(itemOnePage.status, 200);
  const csrf = extractCsrf(itemOnePage.text);
  const blockedComplete = await request(app)
    .post(`/student/content/${itemTwo.id}/complete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(blockedComplete.status, 404);

  // Completing Lesson One's own item unlocks Lesson Two.
  const completeOne = await request(app)
    .post(`/student/content/${itemOne.id}/complete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(completeOne.status, 302);

  const lessonsAfter = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  assert.match(lessonsAfter.text, new RegExp(`href="/student/content/${itemTwo.id}"`));
  const itemTwoPage = await request(app).get(`/student/content/${itemTwo.id}`).set('Cookie', cookie);
  assert.equal(itemTwoPage.status, 200);
});

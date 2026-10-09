// Coverage for a real request: "Each assignment should be another sub
// bar under the assignment title. Each assignment says title and due
// date and a check mark. When you click on the assignment it opens it to
// another page with a back button link to view the assignment and
// complete it." (routes/student-portal.js and routes/parent-portal.js's
// own GET /content/:id, views/student-lesson-content.ejs/parent-lesson-
// content.ejs via partials/lesson-content-detail.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-content-detail-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-content-detail-test-uploads-${process.pid}`);
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

let n = 0;
async function createStudentAccount(name) {
  n += 1;
  const code = await generateMemberCode();
  const studentInfo = await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1)").run(name, code, code);
  const email = `lesson-detail-${n}@example.com`;
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())").run(studentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, studentRole.id);
  return { studentId: studentInfo.lastInsertRowid, email };
}

test('Lessons tab shows a clickable sub-bar (title + due date + check mark) that opens a detail page with a back link', async () => {
  const admin = await loginAsAdmin();
  n += 1;
  const className = `Detail Page Class ${n}`;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'monday', className, hourPosition: '1', room: 'Room A', color: '#EE9A4D', startTime: '9:00 AM', endTime: '9:45 AM', _csrf: admin.csrfToken });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  const student = await createStudentAccount('Detail Page Student');
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, student.studentId);

  const manage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const manageCsrf = extractCsrf(manage.text);
  await request(app).post(`/admin/class-schedule/classes/${cls.id}/assignments`).set('Cookie', admin.cookie).type('form').send({ title: 'A Lesson', _csrf: manageCsrf });
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ?').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'text', title: 'Reading Notes', body: 'Here is the full text body.', contentDueDate: '2026-12-25', _csrf: manageCsrf });
  const contentItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'text'").get(assignment.id);

  const loginRes = await request(app).post('/login').type('form').send({ email: student.email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const lessonsTab = await request(app).get(`/student/classes/${cls.id}?tab=lessons`).set('Cookie', cookie);
  assert.equal(lessonsTab.status, 200);
  assert.match(lessonsTab.text, /Reading Notes/);
  assert.match(lessonsTab.text, /Due Fri 12\/25/);
  assert.match(lessonsTab.text, new RegExp(`href="/student/content/${contentItem.id}"`));
  assert.match(lessonsTab.text, /aria-label="Not complete"/);
  // The body itself is NOT inlined on the Lessons tab any more.
  assert.doesNotMatch(lessonsTab.text, /Here is the full text body/);

  const detail = await request(app).get(`/student/content/${contentItem.id}`).set('Cookie', cookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Here is the full text body/);
  assert.match(detail.text, /Due Fri 12\/25/);
  assert.match(detail.text, new RegExp(`href="/student/classes/${cls.id}\\?tab=lessons"`), 'expected a back link to the Lessons tab');
  assert.match(detail.text, /Part of: A Lesson/);
});

test('GET /student/content/:id 404s for a content item outside this student\'s own classes', async () => {
  const admin = await loginAsAdmin();
  n += 1;
  const className = `Detail Page Outsider Class ${n}`;
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'monday', className, hourPosition: '2', room: 'Room A', color: '#EE9A4D', startTime: '9:00 AM', endTime: '9:45 AM', _csrf: admin.csrfToken });
  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  const manage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  const manageCsrf = extractCsrf(manage.text);
  await request(app).post(`/admin/class-schedule/classes/${cls.id}/assignments`).set('Cookie', admin.cookie).type('form').send({ title: 'Outsider Lesson', _csrf: manageCsrf });
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ?').get(cls.id);
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'text', title: 'Not Yours', body: 'Secret body.', _csrf: manageCsrf });
  const contentItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'text'").get(assignment.id);

  const student = await createStudentAccount('Not Enrolled Student');
  const loginRes = await request(app).post('/login').type('form').send({ email: student.email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];

  const detail = await request(app).get(`/student/content/${contentItem.id}`).set('Cookie', cookie);
  assert.equal(detail.status, 404);
});

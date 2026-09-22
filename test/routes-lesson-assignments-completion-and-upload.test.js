// Coverage for a real request: "Main admin portal, class lessons. Add a
// new lesson should be a button, when you click it there is a popup to
// add information. On lesson list show percentage of how many people in
// the class completed the assignments. Add content should say add
// assignments. Link to video should include a description area. Link to
// file should include a description area. There should be an option in
// the dropdown menu for assignment upload, text box with word count and
// full editing features, also be able to upload a file such as doc,
// pdf, jpg etc. Lesson content says assignments."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-assignments-upload-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-assignments-upload-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');

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
async function createClass() {
  classCounter += 1;
  return (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES (?, 'monday', 1) RETURNING id").get(`Assignment Class ${classCounter}`)
  ).id;
}

async function enrollActiveStudent(classId, name) {
  const code = await generateMemberCode();
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1) RETURNING id").get(name, code, code)
  ).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);
  return studentId;
}

test('New Lesson is a button that opens a popup dialog, not an always-visible inline form', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=assignments`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /onclick="document\.getElementById\('add-lesson-dialog'\)\.showModal\(\)"/);
  assert.match(page.text, /<dialog id="add-lesson-dialog" class="class-form-dialog">/);
  assert.match(page.text, /<h3>New Lesson<\/h3>/);
});

test('Lesson list shows a Completed percentage column - "—" with no quiz content, a real percent once quizzes exist and are attempted', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  await enrollActiveStudent(classId, 'Completion Student One');
  const student2 = await enrollActiveStudent(classId, 'Completion Student Two');

  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'No Quiz Lesson', _csrf: admin.csrfToken });

  const noQuizAssignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('No Quiz Lesson');

  const listBefore = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=assignments`).set('Cookie', admin.cookie);
  // No quiz content at all - not measurable, so "—" not a misleading 0%.
  assert.match(listBefore.text, /—<\/td>\s*<td><a class="roster-action-btn"/);

  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Quiz Lesson', _csrf: admin.csrfToken });
  const quizAssignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('Quiz Lesson');

  await request(app)
    .post(`/admin/class-schedule/assignments/${quizAssignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'quiz', title: 'The Quiz', _csrf: admin.csrfToken });
  const quizItem = await db.prepare('SELECT id FROM lesson_content_items WHERE assignment_id = ? AND type = ?').get(quizAssignment.id, 'quiz');

  // Only one of the two enrolled students has attempted it - 50%.
  await db
    .prepare("INSERT INTO quiz_attempts (content_item_id, student_id, status, points_possible) VALUES (?, ?, 'graded', 0)")
    .run(quizItem.id, student2);

  const listAfter = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=assignments`).set('Cookie', admin.cookie);
  assert.match(listAfter.text, /50%<\/td>\s*<td><a class="roster-action-btn"/);
});

test('Content page renames: "Add Assignments" (was Add Content), "Assignments (N)" heading (was Lesson Content)', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Rename Test Lesson', _csrf: admin.csrfToken });
  const assignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('Rename Test Lesson');

  const page = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h3>Add Assignments<\/h3>/);
  assert.match(page.text, /<button type="submit" class="primary-btn">Add Assignments<\/button>/);
  assert.match(page.text, /<h2>Assignments \(0\)<\/h2>/);
  assert.doesNotMatch(page.text, />Add Content</);
  assert.doesNotMatch(page.text, />Lesson Content</);
});

test('Link to Video and Link to File content types accept a description, shown alongside the lesson content', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Description Fields Lesson', _csrf: admin.csrfToken });
  const assignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('Description Fields Lesson');

  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'video', title: 'Intro Video', videoUrl: 'https://example.com/video', description: 'Watch before Wednesday', _csrf: admin.csrfToken });
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'file', title: 'Worksheet', fileUrl: 'https://example.com/worksheet.pdf', description: 'Print two copies', _csrf: admin.csrfToken });

  const page = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  assert.match(page.text, /Watch before Wednesday/);
  assert.match(page.text, /Print two copies/);

  const videoItem = await db.prepare("SELECT description FROM lesson_content_items WHERE assignment_id = ? AND type = 'video'").get(assignment.id);
  const fileItem = await db.prepare("SELECT description FROM lesson_content_items WHERE assignment_id = ? AND type = 'file'").get(assignment.id);
  assert.equal(videoItem.description, 'Watch before Wednesday');
  assert.equal(fileItem.description, 'Print two copies');
});

test('Assignment Upload content type: dropdown option exists, saves rich-text body and an uploaded file attachment', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass();
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Upload Lesson', _csrf: admin.csrfToken });
  const assignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('Upload Lesson');

  const beforePage = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  assert.match(beforePage.text, /<option value="assignment_upload">Assignment Upload<\/option>/);
  assert.match(beforePage.text, /data-word-count-source/);
  assert.match(beforePage.text, /name="attachment"/);

  const tmpFilePath = path.join(os.tmpdir(), `assignment-upload-test-${process.pid}.pdf`);
  fs.writeFileSync(tmpFilePath, '%PDF-1.4 test file content');

  const create = await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('type', 'assignment_upload')
    .field('title', 'Essay Assignment')
    .field('body', '<p>Write a 500 word essay.</p>')
    .attach('attachment', tmpFilePath, { filename: 'essay-prompt.pdf', contentType: 'application/pdf' });
  assert.equal(create.status, 302);
  fs.rmSync(tmpFilePath, { force: true });

  const item = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'assignment_upload'").get(assignment.id);
  assert.ok(item, 'assignment_upload content item should have been created');
  assert.match(item.body, /Write a 500 word essay/);
  assert.equal(item.attachment_name, 'essay-prompt.pdf');
  assert.ok(item.attachment_url);

  const afterPage = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  assert.match(afterPage.text, /Write a 500 word essay/);
  assert.match(afterPage.text, /essay-prompt\.pdf/);
});

test('Assignment Upload content shows up read-only on the Student Portal Lessons view, with its attachment link', async () => {
  const { hashPassword } = require('../utils/portalAuth');
  const admin = await loginAsAdmin();
  const classId = await createClass();
  const studentId = await enrollActiveStudent(classId, 'Upload View Student');
  const email = 'upload-view-student@example.com';
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(studentId, email, hashPassword('testpassword123'));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, studentRole.id);

  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Visible Upload Lesson', _csrf: admin.csrfToken });
  const assignment = await db.prepare('SELECT id FROM class_assignments WHERE title = ?').get('Visible Upload Lesson');
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'assignment_upload', title: 'Read Chapter 1', body: 'Summarize chapter 1 in your own words.', _csrf: admin.csrfToken });

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get(`/student/classes/${classId}?tab=lessons`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Read Chapter 1/);
  assert.match(page.text, /Summarize chapter 1 in your own words/);
});

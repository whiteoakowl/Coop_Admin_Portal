// Coverage for a real bug report: "edit lesson, there should be an edit
// and trash icon on all assignments. Should be able to click on the
// assignments. Shrink table to fit mobile view. I have zero way of
// managing the quizzes or any other created assignments." updateContentItem
// (utils/academics.js) already existed but no route ever called it, so a
// content item's own title/url/body/due date/points could only be set
// once, at creation - these tests exercise the new POST .../content/:id/edit
// routes (Co-op Admin and Teacher Portal) that finally wire it up, plus
// the page's own Edit/Delete icons and mobile table-stacking markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `lesson-content-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `lesson-content-edit-test-uploads-${process.pid}`);
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
const { createAssignment, createContentItem, getContentItem } = require('../utils/academics');

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
async function createClassAndAssignment() {
  classCounter += 1;
  const classId = (
    await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES (?, 'monday', 1) RETURNING id").get(`Content Edit Test Class ${classCounter}`)
  ).id;
  const assignmentId = await createAssignment({ classId, className: `Content Edit Test Class ${classCounter}`, title: 'Lesson', createdByAccountId: null });
  return { classId, assignmentId };
}

async function createTeacherForClass(classId, email) {
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
  return { teacherId, cookie: loginRes.headers['set-cookie'] };
}

test('Co-op Admin: editing a text content item updates its body and due date', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();
  const contentId = await createContentItem({ assignmentId, type: 'text', title: 'Original Title', body: '<p>Original</p>' });

  const res = await request(app)
    .post(`/admin/class-schedule/content/${contentId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Updated Title', body: '<p>Updated body</p>', contentDueDate: '2027-05-01', _csrf: admin.csrfToken });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /notice=Assignment updated/);

  const item = await getContentItem(contentId);
  assert.equal(item.title, 'Updated Title');
  assert.match(item.body, /Updated body/);
  assert.equal(item.due_date, '2027-05-01');
});

test('Co-op Admin: editing a video content item updates its URL and description', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();
  const contentId = await createContentItem({ assignmentId, type: 'video', title: 'Video', videoUrl: 'https://example.com/old', description: 'Old desc' });

  const res = await request(app)
    .post(`/admin/class-schedule/content/${contentId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Video', videoUrl: 'https://example.com/new', description: 'New desc', _csrf: admin.csrfToken });

  assert.equal(res.status, 302);
  const item = await getContentItem(contentId);
  assert.equal(item.video_url, 'https://example.com/new');
  assert.equal(item.description, 'New desc');
});

test('Co-op Admin: editing an assignment_submission content item updates its body and points possible', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();
  const contentId = await createContentItem({ assignmentId, type: 'assignment_submission', title: 'Essay', body: '<p>Old</p>', pointsPossible: 10 });

  const res = await request(app)
    .post(`/admin/class-schedule/content/${contentId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Essay', submissionBody: '<p>New instructions</p>', submissionPointsPossible: '25', _csrf: admin.csrfToken });

  assert.equal(res.status, 302);
  const item = await getContentItem(contentId);
  assert.match(item.body, /New instructions/);
  assert.equal(item.points_possible, 25);
});

test('Co-op Admin: a quiz content item can have its title edited without touching its questions', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();
  const contentId = await createContentItem({ assignmentId, type: 'quiz', title: 'Quiz v1' });

  const res = await request(app)
    .post(`/admin/class-schedule/content/${contentId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Quiz v2', _csrf: admin.csrfToken });

  assert.equal(res.status, 302);
  const item = await getContentItem(contentId);
  assert.equal(item.title, 'Quiz v2');
});

test('Lesson page shows an Edit and Delete icon for every content item, a clickable title, and a mobile-stacking table', async () => {
  const admin = await loginAsAdmin();
  const { assignmentId } = await createClassAndAssignment();
  await createContentItem({ assignmentId, type: 'text', title: 'Row One', body: '<p>Hi</p>' });
  await createContentItem({ assignmentId, type: 'quiz', title: 'Row Two' });

  const page = await request(app).get(`/admin/class-schedule/assignments/${assignmentId}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /table-stack-mobile/);
  assert.match(page.text, /content-item-title-trigger/);
  assert.match(page.text, /#icon-edit/);
  assert.match(page.text, /#icon-trash/);
  assert.doesNotMatch(page.text, />Delete</);
  // The quiz row still links to its own question manager.
  assert.match(page.text, /Manage Questions/);
});

test('Teacher Portal: a teacher can edit their own class\'s content item, but not one on a class they do not teach', async () => {
  const { assignmentId: ownAssignmentId, classId: ownClassId } = await createClassAndAssignment();
  const { assignmentId: otherAssignmentId } = await createClassAndAssignment();
  const teacher = await createTeacherForClass(ownClassId, 'teacher-edit-test@example.com');

  const ownContentId = await createContentItem({ assignmentId: ownAssignmentId, type: 'file', title: 'Handout', fileUrl: 'https://example.com/old.pdf' });
  const otherContentId = await createContentItem({ assignmentId: otherAssignmentId, type: 'file', title: 'Not Mine', fileUrl: 'https://example.com/old.pdf' });

  const teacherPage = await request(app).get(`/teacher/assignments/${ownAssignmentId}`).set('Cookie', teacher.cookie);
  const csrfToken = extractCsrf(teacherPage.text);

  const res = await request(app)
    .post(`/teacher/content/${ownContentId}/edit`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ title: 'Handout', fileUrl: 'https://example.com/new.pdf', fileDescription: '', _csrf: csrfToken });
  assert.equal(res.status, 302);
  const ownItem = await getContentItem(ownContentId);
  assert.equal(ownItem.file_url, 'https://example.com/new.pdf');

  const forbidden = await request(app)
    .post(`/teacher/content/${otherContentId}/edit`)
    .set('Cookie', teacher.cookie)
    .type('form')
    .send({ title: 'Hacked', fileUrl: 'https://example.com/hacked.pdf', fileDescription: '', _csrf: csrfToken });
  assert.equal(forbidden.status, 403);
  const otherItem = await getContentItem(otherContentId);
  assert.equal(otherItem.file_url, 'https://example.com/old.pdf');
});

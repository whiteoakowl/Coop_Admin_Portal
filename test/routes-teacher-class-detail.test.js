// Coverage for a real request: "Teacher portal. When clicking on a class
// they view the class like a student portal or parent portal would and
// they can click through assignment and such. This way they can use the
// lesson plans in class as well for easy access. Then teacher portal has
// an edit class button that goes to a page where they can edit their
// class information lesson plans etc." Reuses the exact same read-only
// "staff viewing their own class" page Parent Portal's own Classroom
// Dashboard already built for a teacher/assistant with no child involved
// (routes/parent-portal.js's own ?viewer=parent-<id> branch) - this is
// that same behavior natively on Co-op Teacher Portal's own GET /classes/:id,
// with the old roster/assignment-management page moved to its own
// GET /classes/:id/edit behind an "Edit Class" button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-class-detail-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-class-detail-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');
const { createClass } = require('../utils/classSchedule');
const { createAssignment, createContentItem } = require('../utils/academics');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let teacherCounter = 0;
async function loginTeacher(classIds) {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Class Detail Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  for (const classId of classIds) {
    await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  }
  const email = `class-detail-teacher-${teacherCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return loginRes.headers['set-cookie'];
}

test('clicking a class lands on the read-only view page (Details/Lessons tabs), with an Edit Class button', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Nature Study', room: 'Room 2' });
  const cookie = await loginTeacher([classId]);

  const page = await request(app).get(`/teacher/classes/${classId}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Nature Study<\/h1>/);
  assert.match(page.text, /class="roster-action-btn" href="\/teacher\/classes\/\d+\/edit">Edit Class</);
  assert.match(page.text, /class="view-tab active" href="\?tab=details">Details/);
  assert.match(page.text, /href="\?tab=lessons">Lessons/);
  // Scoped to this page's own .view-tabs row, not the sidebar (which has
  // its own global "Assignments" nav link, unrelated to this check) -
  // assignments/grades/attendance are per-student, not shown here.
  const viewTabsSection = /<div class="view-tabs no-print">[\s\S]*?<\/div>/.exec(page.text)[0];
  assert.doesNotMatch(viewTabsSection, />Assignments</);
  assert.doesNotMatch(viewTabsSection, />Grades</);
  assert.doesNotMatch(viewTabsSection, />Attendance</);
  // The old page's own content (roster table, New Assignment form) should
  // not be what clicking the class shows any more.
  assert.doesNotMatch(page.text, /No students enrolled yet\./);
});

test('the Details tab shows the same class-info fields the student/parent view already does', async () => {
  const classId = await createClass({
    day: 'wednesday', hourPosition: 2, className: 'Pottery', room: 'Studio B',
    startDate: '2026-09-01', endDate: '2026-12-01', description: 'Hands-on pottery.',
  });
  const cookie = await loginTeacher([classId]);
  const page = await request(app).get(`/teacher/classes/${classId}?tab=details`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Studio B/);
  assert.match(page.text, /2026-09-01/);
  assert.match(page.text, /2026-12-01/);
  assert.match(page.text, /Hands-on pottery\./);
});

test('the Lessons tab shows the class\'s own lessons and lets the teacher click through a content item, read-only', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Lessons Class' });
  const cookie = await loginTeacher([classId]);
  const assignmentId = await createAssignment({ classId, className: 'Lessons Class', title: 'Week One', createdByAccountId: null });
  const contentItemId = await createContentItem({ assignmentId, type: 'text', title: 'Reading', body: 'Some text content.' });

  const lessonsTab = await request(app).get(`/teacher/classes/${classId}?tab=lessons`).set('Cookie', cookie);
  assert.equal(lessonsTab.status, 200);
  assert.match(lessonsTab.text, /Week One/);
  assert.match(lessonsTab.text, new RegExp(`href="/teacher/content/${contentItemId}"`));

  const detail = await request(app).get(`/teacher/content/${contentItemId}`).set('Cookie', cookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Some text content\./);
  assert.match(detail.text, new RegExp(`href="/teacher/classes/${classId}\\?tab=lessons"`), 'expected a back link to the Lessons tab');
  // Read-only: no Mark Complete / submission controls (canTakeQuiz is
  // always false in this staff view - no student to complete this for).
  assert.doesNotMatch(detail.text, /Mark Complete/);
});

test('GET /teacher/content/:id 404s for a content item outside this teacher\'s own classes', async () => {
  const outsiderClassId = await createClass({ day: 'monday', hourPosition: 4, className: 'Not My Class' });
  const assignmentId = await createAssignment({ classId: outsiderClassId, className: 'Not My Class', title: 'Secret Lesson', createdByAccountId: null });
  const contentItemId = await createContentItem({ assignmentId, type: 'text', title: 'Secret', body: 'nope' });

  const myClassId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'My Own Class' });
  const cookie = await loginTeacher([myClassId]);

  const res = await request(app).get(`/teacher/content/${contentItemId}`).set('Cookie', cookie);
  assert.equal(res.status, 404);
});

test('the Edit Class page (GET /classes/:id/edit) still has the roster and New Assignment form the old page had', async () => {
  const classId = await createClass({ day: 'wednesday', hourPosition: 3, className: 'Edit Me Class' });
  const cookie = await loginTeacher([classId]);
  const page = await request(app).get(`/teacher/classes/${classId}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Edit Edit Me Class<\/h1>/);
  assert.match(page.text, /No students enrolled yet\./);
  assert.match(page.text, /New Assignment/);
  assert.match(page.text, new RegExp(`action="/teacher/classes/${classId}/assignments"`));
  assert.match(page.text, new RegExp(`href="/teacher/classes/${classId}">`), 'expected a back link to the read-only view page');
});

test('Chat tab only appears when the class has allow_parent_chat on, and posting a message works', async () => {
  const classId = await createClass({ day: 'wednesday', hourPosition: 4, className: 'Chat Class', allowParentChat: true });
  const cookie = await loginTeacher([classId]);

  const page = await request(app).get(`/teacher/classes/${classId}`).set('Cookie', cookie);
  assert.match(page.text, /href="\?tab=chat">Chat/);

  const noChatClassId = await createClass({ day: 'monday', hourPosition: 2, className: 'No Chat Class', allowParentChat: false });
  const cookie2 = await loginTeacher([noChatClassId]);
  const page2 = await request(app).get(`/teacher/classes/${noChatClassId}`).set('Cookie', cookie2);
  assert.doesNotMatch(page2.text, /href="\?tab=chat">Chat/);

  const csrfMatch = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  await request(app)
    .post(`/teacher/classes/${classId}/chat`)
    .set('Cookie', cookie)
    .type('form')
    .send({ body: 'Hello class', _csrf: csrfMatch[1] });
  const chatTab = await request(app).get(`/teacher/classes/${classId}?tab=chat`).set('Cookie', cookie);
  assert.match(chatTab.text, /Hello class/);
});

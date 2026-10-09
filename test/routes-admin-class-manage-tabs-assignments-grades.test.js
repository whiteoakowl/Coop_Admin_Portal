// Coverage for a real request: "Co-op admin portal, schedules tab should
// be called classes. When you click a classes it should take you to the
// classes full settings page with tabs for all of that classes features.
// Admin and teachers can change classes information or upload
// assignments, grades etc." Teacher Portal already lets a teacher manage
// their own class's assignments/grades (routes/teacher-portal.js); this
// adds the admin-side equivalent as new Assignments/Grades tabs on the
// class's own full settings page (views/admin-class-schedule-manage.ejs),
// alongside the pre-existing Details/Staff & Roster content, and renames
// the Co-op Admin nav's own "Schedules" item to "Classes".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-class-manage-tabs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-class-manage-tabs-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

async function createClass(admin, overrides) {
  const className = (overrides && overrides.className) || 'Tabbed Manage Class';
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      day: 'monday',
      className,
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      _csrf: admin.csrfToken,
      ...overrides,
    });
  return db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
}

test('Co-op Admin nav: the Schedules item is now called Classes', async () => {
  const admin = await loginAsAdmin();
  const page = await request(app).get('/admin').set('Cookie', admin.cookie);
  const navMatch = /<nav id="admin-nav-links">([\s\S]*?)<\/nav>/.exec(page.text);
  assert.ok(navMatch);
  // The Classes item now has its own subpages (Class Schedules/Member
  // Schedules/Settings), so it renders as a <details> group summary -
  // "Classes" followed by the group's own dropdown chevron, not a plain
  // "Classes</a>" link any more.
  assert.match(navMatch[1], /Classes <svg class="icon admin-nav-group-chevron"/);
  assert.doesNotMatch(navMatch[1], /Schedules <svg class="icon admin-nav-group-chevron"/);
});

test('Class Schedules grid: a class card links straight to its own full Manage page (data-view-class + class-schedule-view.js navigates, no more popup)', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Grid Click Class' });
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`data-view-class="${cls.id}"`));
  assert.match(page.text, /src="\/js\/class-schedule-view\.js"/);
});

test('Class Manage page: renders Details/Staff & Roster/Assignments/Grades tabs, defaulting to Details', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Tab Strip Class' });
  const page = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="view-tab active" href="\?tab=details">Details<\/a>/);
  assert.match(page.text, /<a class="view-tab" href="\?tab=staffRoster">Staff &amp; Roster<\/a>/);
  assert.match(page.text, /<a class="view-tab" href="\?tab=assignments">Lessons<\/a>/);
  assert.match(page.text, /<a class="view-tab" href="\?tab=grades">Grades<\/a>/);
  assert.match(page.text, /<a class="view-tab" href="\?tab=chat">Chat<\/a>/);
  assert.match(page.text, /Class Details/);
  assert.doesNotMatch(page.text, /Teachers &amp; Assistants/);
});

test('Class Manage page: Staff & Roster tab shows the roster content, Assignments/Grades tabs are empty until an assignment exists', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Staff Roster Tab Class' });

  const staffRoster = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=staffRoster`).set('Cookie', admin.cookie);
  assert.match(staffRoster.text, /Teachers &amp; Assistants/);
  assert.match(staffRoster.text, /Student Roster/);

  const assignmentsTab = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=assignments`).set('Cookie', admin.cookie);
  assert.match(assignmentsTab.text, /No lessons yet/);
  assert.match(assignmentsTab.text, /New Lesson/);

  const gradesTab = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=grades`).set('Cookie', admin.cookie);
  assert.match(gradesTab.text, /No lessons to grade yet/);
});

test('Class Manage page: Chat tab shows a message log; posting a message from the admin session shows it with the admin\'s username', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Chat Tab Class' });

  const emptyChat = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=chat`).set('Cookie', admin.cookie);
  assert.match(emptyChat.text, /No messages yet/);
  const csrf = extractCsrf(emptyChat.text);

  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/chat`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ body: 'Reminder: field trip permission slips due Friday.', _csrf: csrf });

  const afterPost = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=chat`).set('Cookie', admin.cookie);
  assert.match(afterPost.text, /Reminder: field trip permission slips due Friday\./);
  assert.match(afterPost.text, /testadmin/);
});

test('Class Manage page: create an assignment from the Assignments tab, then grade it from the Grades tab', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Grading Flow Class' });
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Grading Flow Student', 'grading-flow-student', 'student', 1)").run()
  ).lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(cls.id, studentId);

  const assignmentsPage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=assignments`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(assignmentsPage.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fractions Worksheet', description: 'Complete pages 1-3.', dueDate: '2027-01-15', pointsPossible: '10', _csrf: csrf });

  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? AND title = ?').get(cls.id, 'Fractions Worksheet');
  assert.ok(assignment, 'the assignment should be created');

  const afterCreate = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=assignments`).set('Cookie', admin.cookie);
  assert.match(afterCreate.text, /Fractions Worksheet/);
  // A real bug report: "there is no manage or trash button at the end of
  // each class assignment in co-op admin portal" - Manage is now an icon
  // link (no "Manage" text) and a Delete icon button/form was added.
  assert.match(afterCreate.text, new RegExp(`<a class="icon-btn" href="/admin/class-schedule/assignments/${assignment.id}" aria-label="Manage" title="Manage">`));
  assert.match(afterCreate.text, new RegExp(`<form method="POST" action="/admin/class-schedule/assignments/${assignment.id}/delete"`));
  assert.match(afterCreate.text, /aria-label="Delete" title="Delete"><svg class="icon"><use href="#icon-trash"\/><\/svg><\/button>/);

  const gradesTab = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=grades`).set('Cookie', admin.cookie);
  assert.match(gradesTab.text, /Fractions Worksheet/);
  assert.match(gradesTab.text, /0 \/ 1/); // 0 graded of 1 enrolled student

  const gradebookPage = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  assert.equal(gradebookPage.status, 200);
  assert.match(gradebookPage.text, /Grading Flow Student/);
  const gradebookCsrf = extractCsrf(gradebookPage.text);

  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/grades`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ [`points_${studentId}`]: '9', [`feedback_${studentId}`]: 'Great work!', _csrf: gradebookCsrf });

  const grade = await db.prepare('SELECT * FROM assignment_grades WHERE assignment_id = ? AND student_id = ?').get(assignment.id, studentId);
  assert.equal(Number(grade.points_earned), 9);
  assert.equal(grade.feedback, 'Great work!');

  const gradesTabAfter = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=grades`).set('Cookie', admin.cookie);
  assert.match(gradesTabAfter.text, /1 \/ 1/);
});

// A real bug report: "there is no manage or trash button at the end of
// each class assignment in co-op admin portal" - there was no way to
// delete a lesson at all before this.
test('Lessons tab: the Delete icon button removes a lesson and its content/grades', async () => {
  const admin = await loginAsAdmin();
  const cls = await createClass(admin, { className: 'Delete Lesson Class' });

  const assignmentsPage = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=assignments`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(assignmentsPage.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/assignments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Doomed Lesson', _csrf: csrf });
  const assignment = await db.prepare('SELECT * FROM class_assignments WHERE class_id = ? AND title = ?').get(cls.id, 'Doomed Lesson');
  assert.ok(assignment, 'the lesson should be created');

  const lessonPage = await request(app).get(`/admin/class-schedule/assignments/${assignment.id}`).set('Cookie', admin.cookie);
  const lessonCsrf = extractCsrf(lessonPage.text);
  await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'text', title: 'Reading', body: '<p>Read chapter 1.</p>', _csrf: lessonCsrf });
  const contentItem = await db.prepare('SELECT * FROM lesson_content_items WHERE assignment_id = ?').get(assignment.id);
  assert.ok(contentItem, 'the content item should be created');

  const deleteRes = await request(app)
    .post(`/admin/class-schedule/assignments/${assignment.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: lessonCsrf });
  assert.equal(deleteRes.status, 302);
  assert.match(deleteRes.headers.location, new RegExp(`^/admin/class-schedule/classes/${cls.id}/manage\\?tab=assignments&notice=`));

  assert.equal(await db.prepare('SELECT * FROM class_assignments WHERE id = ?').get(assignment.id), undefined);
  assert.equal(await db.prepare('SELECT * FROM lesson_content_items WHERE id = ?').get(contentItem.id), undefined, 'content items should cascade-delete with the lesson');

  const afterDelete = await request(app).get(`/admin/class-schedule/classes/${cls.id}/manage?tab=assignments`).set('Cookie', admin.cookie);
  assert.doesNotMatch(afterDelete.text, /Doomed Lesson/);
  assert.match(afterDelete.text, /No lessons yet/);
});

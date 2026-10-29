// Coverage for a real request: "Co-op admin portal add a tab called
// lesson plans. On this page there are the same class settings lesson
// plan settings and features. Admins can create lessons plans and assign
// them to a class to be used as an option. Teachers can also still
// create their own lesson plans like they do now. Once the admin created
// lesson plan is added to a class it can then be edited by the teacher
// without changing the main copy admins have on their end. Essentially
// its like adding a ready made lesson plan template to a class, the
// teacher can tweak it without changing the original." Covers: the new
// nav tab, creating/editing/deleting a lesson plan, adding content items
// (text and quiz, with a quiz question) to a template, and the "Assign
// to Class" deep copy - the new class lesson gets every field, and
// editing either side afterward never touches the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-lesson-plans-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-lesson-plans-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');

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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Co-op Admin nav has a Lesson Plans tab', async () => {
  const admin = await loginAsAdmin();
  const page = await request(app).get('/admin').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a href="\/admin\/lesson-plans">[\s\S]*?Lesson Plans<\/a>/);
});

test('Lesson Plans list page: empty state, then a created plan appears as a card', async () => {
  const admin = await loginAsAdmin();
  const empty = await request(app).get('/admin/lesson-plans').set('Cookie', admin.cookie);
  assert.equal(empty.status, 200);
  assert.match(empty.text, /No lesson plans yet/);

  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Watercolor Basics', description: 'A starter template.', _csrf: admin.csrfToken });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.location, /\/admin\/lesson-plans\/\d+/);

  const list = await request(app).get('/admin/lesson-plans').set('Cookie', admin.cookie);
  assert.match(list.text, /Watercolor Basics/);
  assert.match(list.text, /A starter template\./);
});

test('A lesson plan\'s own manage page: Lesson Plan Details form, add a text content item (line breaks preserved), add a quiz with a question', async () => {
  const admin = await loginAsAdmin();
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Reading Plan', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const manage = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /Lesson Plan Details/);
  assert.doesNotMatch(manage.text, /Open Date/, 'a template has no Open/Close Date - only a real class lesson does');

  await request(app)
    .post(`/admin/lesson-plans/${planId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'text', title: 'Intro Reading', body: 'Line one\nLine two', _csrf: admin.csrfToken });

  const withText = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.match(withText.text, /class="hint plain-text-display">Line one\nLine two</);

  await request(app)
    .post(`/admin/lesson-plans/${planId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'quiz', title: 'Check Quiz', _csrf: admin.csrfToken });

  const contentItem = await db.prepare("SELECT * FROM lesson_plan_content_items WHERE lesson_plan_id = ? AND type = 'quiz'").get(planId);
  const questionsPage = await request(app).get(`/admin/lesson-plans/content/${contentItem.id}/questions`).set('Cookie', admin.cookie);
  assert.equal(questionsPage.status, 200);
  assert.match(questionsPage.text, /Check Quiz/);

  await request(app)
    .post(`/admin/lesson-plans/content/${contentItem.id}/questions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'multiple_choice', prompt: 'What color is the sky?', pointsPossible: '1', correctChoice: '1', choice1: 'Blue', choice2: 'Green', _csrf: admin.csrfToken });

  const withQuiz = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.match(withQuiz.text, /1 question/);
});

// A real request: "Add allow members to use this lesson plan for
// Homeschool family management" - a single checkbox saved alongside
// title/description on the same Lesson Plan Details form, off by
// default.
test('Lesson Plan Details form: the Homeschool family management checkbox defaults off and persists when checked', async () => {
  const admin = await loginAsAdmin();
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Family Use Plan', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const manage = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.match(manage.text, /Allow members to use this lesson plan for Homeschool family management/);
  assert.doesNotMatch(manage.text, /name="allowFamilySchoolUse" value="1" checked/);

  await request(app)
    .post(`/admin/lesson-plans/${planId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Family Use Plan', description: '', allowFamilySchoolUse: '1', _csrf: admin.csrfToken });

  const plan = await db.prepare('SELECT allow_family_school_use FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(plan.allow_family_school_use, true);

  const checkedPage = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.match(checkedPage.text, /name="allowFamilySchoolUse" value="1" checked/);

  // Saving again without the checkbox (unchecked box never posts a
  // value) must turn it back off.
  await request(app)
    .post(`/admin/lesson-plans/${planId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Family Use Plan', description: '', _csrf: admin.csrfToken });
  const unchecked = await db.prepare('SELECT allow_family_school_use FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(unchecked.allow_family_school_use, false);
});

test('Assign to Class deep-copies the lesson plan as a brand new, fully independent class lesson', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Art Class' });

  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Watercolor Template', description: 'Paint something.', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  await request(app)
    .post(`/admin/lesson-plans/${planId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'text', title: 'Materials', body: 'Paper\nPaint\nBrush', _csrf: admin.csrfToken });

  const contentItem = await db.prepare("SELECT * FROM lesson_plan_content_items WHERE lesson_plan_id = ? AND type = 'text'").get(planId);
  assert.equal(contentItem.body, 'Paper\nPaint\nBrush');

  const assignRes = await request(app)
    .post(`/admin/lesson-plans/${planId}/assign`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classId: String(classId), _csrf: admin.csrfToken });
  assert.equal(assignRes.status, 302);
  assert.match(assignRes.headers.location, /\/admin\/class-schedule\/assignments\/\d+/);
  assert.match(decodeURIComponent(assignRes.headers.location), /Added "Watercolor Template" as a new lesson/);

  const newAssignment = await db.prepare("SELECT * FROM class_assignments WHERE title = 'Watercolor Template'").get();
  assert.ok(newAssignment, 'a real class_assignments row should exist');
  assert.equal(newAssignment.class_id, classId);
  assert.equal(newAssignment.description, 'Paint something.');

  const newContentItems = await db.prepare('SELECT * FROM lesson_content_items WHERE assignment_id = ?').all(newAssignment.id);
  assert.equal(newContentItems.length, 1);
  assert.equal(newContentItems[0].type, 'text');
  assert.equal(newContentItems[0].body, 'Paper\nPaint\nBrush');

  // Independence, both directions: editing the real copy must never touch
  // the template, and vice versa.
  await db.prepare('UPDATE lesson_content_items SET body = ? WHERE id = ?').run('Teacher changed this', newContentItems[0].id);
  const templateStillOriginal = await db.prepare('SELECT * FROM lesson_plan_content_items WHERE id = ?').get(contentItem.id);
  assert.equal(templateStillOriginal.body, 'Paper\nPaint\nBrush', 'editing the class copy must not change the template');

  await db.prepare('UPDATE lesson_plan_content_items SET body = ? WHERE id = ?').run('Admin changed the template', contentItem.id);
  const copyStillEdited = await db.prepare('SELECT * FROM lesson_content_items WHERE id = ?').get(newContentItems[0].id);
  assert.equal(copyStillEdited.body, 'Teacher changed this', 'editing the template afterward must not change an already-assigned copy');
});

test('Assign to Class deep-copies a quiz content item\'s own questions and choices', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Quiz Class' });

  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Quiz Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  await request(app)
    .post(`/admin/lesson-plans/${planId}/content`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'quiz', title: 'Pop Quiz', _csrf: admin.csrfToken });
  const contentItem = await db.prepare("SELECT * FROM lesson_plan_content_items WHERE lesson_plan_id = ? AND type = 'quiz'").get(planId);
  await request(app)
    .post(`/admin/lesson-plans/content/${contentItem.id}/questions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'multiple_choice', prompt: '2 + 2?', pointsPossible: '1', correctChoice: '2', choice1: '3', choice2: '4', _csrf: admin.csrfToken });

  await request(app)
    .post(`/admin/lesson-plans/${planId}/assign`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classId: String(classId), _csrf: admin.csrfToken });

  const newAssignment = await db.prepare("SELECT * FROM class_assignments WHERE title = 'Quiz Template'").get();
  const newQuizItem = await db.prepare("SELECT * FROM lesson_content_items WHERE assignment_id = ? AND type = 'quiz'").get(newAssignment.id);
  const newQuestions = await db.prepare('SELECT * FROM quiz_questions WHERE content_item_id = ?').all(newQuizItem.id);
  assert.equal(newQuestions.length, 1);
  assert.equal(newQuestions[0].prompt, '2 + 2?');
  const newChoices = await db.prepare('SELECT * FROM quiz_choices WHERE question_id = ? ORDER BY position').all(newQuestions[0].id);
  assert.deepEqual(newChoices.map((c) => [c.label, c.is_correct]), [['3', 0], ['4', 1]]);
});

// A real request: "Click on an existing lesson plan and there is a
// button called assign to class. Change this button to say Edit
// settings. Click this button and the new page allows you change
// lesson plan settings. Check boxes... allow teachers to edit/add to
// the lesson plan, all members to edit/add to the lesson plan. Dropdown
// to select assigning this lesson plan to a co-op class. Dropdown menu
// shows class titles, time and semester day in parenthesis."
test('Lesson plan manage page links to Edit Settings, not the old Assign to Class dialog', async () => {
  const admin = await loginAsAdmin();
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Settings Link Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const page = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`<a class="roster-action-btn" href="/admin/lesson-plans/${planId}/settings">Edit Settings</a>`));
  assert.doesNotMatch(page.text, />Assign to Class</);
  assert.doesNotMatch(page.text, /assign-lesson-plan-dialog/);
});

test('Lesson plan Settings page: GET shows the edit-permission checkboxes and the class dropdown with title/time/day/semester', async () => {
  const admin = await loginAsAdmin();
  const semesterId = (await db.prepare("INSERT INTO semesters (title) VALUES ('Fall Settings Test') RETURNING id").get()).id;
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Settings Dropdown Class', semesterId });

  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Settings Page Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const page = await request(app).get(`/admin/lesson-plans/${planId}/settings`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /name="allowTeacherEdit" value="1"\s*\/>/);
  assert.match(page.text, /Allow teachers to edit\/add to the lesson plan/);
  assert.match(page.text, /name="allowMemberEdit" value="1"\s*\/>/);
  assert.match(page.text, /Allow all members to edit\/add to the lesson plan/);
  assert.match(page.text, new RegExp(`<option value="${classId}">Settings Dropdown Class \\([^)]+, Monday - Fall Settings Test\\)</`));
});

test('Lesson plan Settings page: POST saves the two edit-permission checkboxes', async () => {
  const admin = await loginAsAdmin();
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Settings Save Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const before = await db.prepare('SELECT allow_teacher_edit, allow_member_edit FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(before.allow_teacher_edit, false);
  assert.equal(before.allow_member_edit, false);

  await request(app)
    .post(`/admin/lesson-plans/${planId}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ allowTeacherEdit: '1', _csrf: admin.csrfToken });

  const afterTeacherOnly = await db.prepare('SELECT allow_teacher_edit, allow_member_edit FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(afterTeacherOnly.allow_teacher_edit, true, 'teacher checkbox should now be on');
  assert.equal(afterTeacherOnly.allow_member_edit, false, 'member checkbox was never checked, should stay off');

  await request(app)
    .post(`/admin/lesson-plans/${planId}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ allowTeacherEdit: '1', allowMemberEdit: '1', _csrf: admin.csrfToken });

  const afterBoth = await db.prepare('SELECT allow_teacher_edit, allow_member_edit FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(afterBoth.allow_teacher_edit, true);
  assert.equal(afterBoth.allow_member_edit, true);
});

test('Lesson plan Settings page: the Assign to Class form still posts to the same /assign route and still works', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Settings Assign Class' });
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Settings Assign Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const settingsPage = await request(app).get(`/admin/lesson-plans/${planId}/settings`).set('Cookie', admin.cookie);
  assert.match(settingsPage.text, new RegExp(`<form method="POST" action="/admin/lesson-plans/${planId}/assign"`));

  const assignRes = await request(app)
    .post(`/admin/lesson-plans/${planId}/assign`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classId: String(classId), _csrf: admin.csrfToken });
  assert.match(assignRes.headers.location, /\/admin\/class-schedule\/assignments\/\d+/);

  // Choosing no class still redirects back to the Settings page (where
  // the dropdown now lives), not the old Manage page.
  const noClassRes = await request(app)
    .post(`/admin/lesson-plans/${planId}/assign`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classId: '', _csrf: admin.csrfToken });
  assert.match(noClassRes.headers.location, new RegExp(`/admin/lesson-plans/${planId}/settings\\?error=`));
});

// A real request: "Family school management portal, family classes.
// Add a subpage called available lesson plans. Any lesson plans that
// admin has created and marked shareable with parent portal will show
// here as cards... Allows you to filter by grade level, and subject."
// Covers the admin-side half: saving these three fields from the Lesson
// Plan Details form.
test('Lesson Plan Details form saves grade level, subject, and shareable-with-parents', async () => {
  const admin = await loginAsAdmin();
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Grade Subject Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  const manage = await request(app).get(`/admin/lesson-plans/${planId}`).set('Cookie', admin.cookie);
  assert.match(manage.text, /<select name="gradeLevel">/);
  assert.match(manage.text, /name="subject"/);
  assert.match(manage.text, /name="shareableWithParents" value="1"\s*\/>/);

  await request(app)
    .post(`/admin/lesson-plans/${planId}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Grade Subject Template', description: '', gradeLevel: '3rd Grade', subject: 'Science', shareableWithParents: '1', _csrf: admin.csrfToken });

  const plan = await db.prepare('SELECT grade_level, subject, shareable_with_parents FROM lesson_plans WHERE id = ?').get(planId);
  assert.equal(plan.grade_level, '3rd Grade');
  assert.equal(plan.subject, 'Science');
  assert.equal(plan.shareable_with_parents, true);
});

test('Deleting a lesson plan does not affect a class it was already assigned to', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Outlives Template Class' });
  const createRes = await request(app)
    .post('/admin/lesson-plans')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Disposable Template', _csrf: admin.csrfToken });
  const planId = /\/admin\/lesson-plans\/(\d+)/.exec(createRes.headers.location)[1];

  await request(app)
    .post(`/admin/lesson-plans/${planId}/assign`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classId: String(classId), _csrf: admin.csrfToken });
  const newAssignment = await db.prepare("SELECT * FROM class_assignments WHERE title = 'Disposable Template'").get();
  assert.ok(newAssignment);

  await request(app).post(`/admin/lesson-plans/${planId}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(await db.prepare('SELECT 1 FROM lesson_plans WHERE id = ?').get(planId), undefined);

  const stillThere = await db.prepare('SELECT * FROM class_assignments WHERE id = ?').get(newAssignment.id);
  assert.ok(stillThere, 'the class\'s own already-assigned lesson must survive the template being deleted');
});

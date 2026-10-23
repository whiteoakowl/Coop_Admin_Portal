// Coverage for three real follow-up requests on the Weekly Planner v2
// (see weekly-planner-dragdrop-and-subject-chart.test.js's own header
// comment for the feature's history):
//
// 1. "Mobile. Each day should be stacked vertically for easier view on
//    mobile. Everything is currently overlapping" - public/css/
//    styles.css's own @media (max-width: 640px) block for
//    .fs-weekly-plan-grid, plus the .fs-weekly-plan-day-label-mobile
//    span each day's own <td> now carries.
// 2. "Add two buttons add class assignment and add new assignment" -
//    the old single "+ Assignment" dialog is now two separate dialogs/
//    buttons; "Add New Assignment" also gained description/link/
//    upload/grade fields on top of the existing subject/title.
// 3. "Check boxes next to each assignment. Check box on each day for
//    teacher to confirm the day is complete" - routes/parent-family-
//    school.js's new .../assignments/:id/toggle-complete and
//    .../dates/:dateId/toggle-complete routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `weekly-planner-v3-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `weekly-planner-v3-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
test.before(() => app.ready);
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { createWeek, createWeekAssignment, createClass, createLesson, createContentItem } = require('../utils/familySchool');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createParent(familyId) {
  counter += 1;
  const code = `wpv3${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Parent ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

async function createStudent(familyId) {
  counter += 1;
  const code = `wpv3s${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
      .get(`Student ${counter}`, code, code, familyId)
  ).id;
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { memberId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('the week grid carries .fs-weekly-plan-day-label-mobile per day for the mobile stacked layout', async () => {
  const familyId = await createFamily('Mobile Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Mobile Week', dates: ['2026-11-02', '2026-11-03'], createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  const matches = page.text.match(/fs-weekly-plan-day-label-mobile/g) || [];
  assert.equal(matches.length, 2, 'one mobile-only day label per day in the week');
});

test('the week grid shows two separate buttons - Class Assignment and New Assignment - not one combined one', async () => {
  const familyId = await createFamily('Split Buttons Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Split Week', dates: ['2026-11-09'], createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /\+ Class Assignment/);
  assert.match(page.text, /\+ New Assignment/);
  assert.doesNotMatch(page.text, /\+ Assignment</, 'the old single combined button is gone');
});

test('Add Class Assignment only offers the dropdown - no freeform subject/title inputs in that dialog', async () => {
  const familyId = await createFamily('Class Assignment Dialog Family');
  const parent = await createParent(familyId);
  const classId = await createClass({ familyId, className: 'Algebra', description: null, createdByAccountId: null });
  const lessonId = await createLesson({ classId, title: 'Lesson 1', description: null, createdByAccountId: null });
  await createContentItem({ lessonId, type: 'assignment_upload', title: 'Worksheet 1' });
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Dialog Week', dates: ['2026-11-16'], createdByAccountId: null });

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  const classDialogMatch = /<dialog id="add-class-assignment-dialog-\d+"[\s\S]*?<\/dialog>/.exec(page.text);
  assert.ok(classDialogMatch, 'expected to find the Add Class Assignment dialog');
  const classDialogHtml = classDialogMatch[0];
  assert.match(classDialogHtml, /Algebra.*Worksheet 1/);
  assert.doesNotMatch(classDialogHtml, /name="subject"/);
  assert.doesNotMatch(classDialogHtml, /name="description"/);
});

test('posting to Add Class Assignment with a real contentItemId creates the assignment with no description/link/grade', async () => {
  const familyId = await createFamily('Class Assignment Post Family');
  const parent = await createParent(familyId);
  const classId = await createClass({ familyId, className: 'Biology', description: null, createdByAccountId: null });
  const lessonId = await createLesson({ classId, title: 'Cells', description: null, createdByAccountId: null });
  const contentItemId = await createContentItem({ lessonId, type: 'assignment_upload', title: 'Diagram' });
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Bio Week', dates: ['2026-11-23'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ contentItemId: String(contentItemId), _csrf: csrf });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const row = await db.prepare('SELECT title, description, link_url, grade, content_item_id FROM family_school_week_assignments WHERE week_date_id = ?').get(dateA.id);
  assert.equal(row.title, 'Diagram');
  assert.equal(row.content_item_id, contentItemId);
  assert.equal(row.description, null);
  assert.equal(row.link_url, null);
  assert.equal(row.grade, null);
});

test('Add New Assignment saves title/subject/description/link/grade and an uploaded file', async () => {
  const familyId = await createFamily('New Assignment Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'New Assignment Week', dates: ['2026-11-30'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/assignments?_csrf=` + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('title', 'Fraction Practice')
    .field('subject', 'Math')
    .field('description', 'Pages 10-12 in the workbook')
    .field('link', 'https://example.com/worksheet')
    .field('grade', 'B+')
    .field('_csrf', csrf)
    .attach('upload', PNG_1X1, { filename: 'worksheet.png', contentType: 'image/png' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const row = await db.prepare('SELECT title, subject, description, link_url, grade, file_key, file_name FROM family_school_week_assignments WHERE week_date_id = ?').get(dateA.id);
  assert.equal(row.title, 'Fraction Practice');
  assert.equal(row.subject, 'Math');
  assert.equal(row.description, 'Pages 10-12 in the workbook');
  assert.equal(row.link_url, 'https://example.com/worksheet');
  assert.equal(row.grade, 'B+');
  assert.equal(row.file_name, 'worksheet.png');
  assert.ok(row.file_key, 'expected a stored file_key for the uploaded file');

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /Fraction Practice/);
  assert.match(page.text, /Pages 10-12 in the workbook/);
  assert.match(page.text, /Grade: B\+/);
  assert.match(page.text, /worksheet\.png/);
});

test('Add New Assignment requires a title', async () => {
  const familyId = await createFamily('New Assignment Required Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Required Week', dates: ['2026-12-07'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/assignments`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ subject: 'Math', _csrf: csrf });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
});

test('checking the box next to an assignment marks it complete and strikes it through', async () => {
  const familyId = await createFamily('Assignment Checkbox Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Checkbox Week', dates: ['2026-12-14'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);
  const assignmentId = await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Quiz Review', contentItemId: null });

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignmentId}/toggle-complete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(res.status, 302);

  const row = await db.prepare('SELECT completed FROM family_school_week_assignments WHERE id = ?').get(assignmentId);
  assert.equal(row.completed, true);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(page.text, new RegExp(`data-assignment-id="${assignmentId}" class="fs-weekly-plan-assignment-done"`));

  // Toggling again flips it back off.
  const csrf2 = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  await request(app).post(`/parent/family-school/weekly-planner/assignments/${assignmentId}/toggle-complete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf2 });
  const row2 = await db.prepare('SELECT completed FROM family_school_week_assignments WHERE id = ?').get(assignmentId);
  assert.equal(row2.completed, false);
});

test('checking the box on a day marks that day complete, independent of its assignments', async () => {
  const familyId = await createFamily('Day Checkbox Family');
  const parent = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Day Checkbox Week', dates: ['2026-12-21'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  const res = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/toggle-complete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(res.status, 302);

  const row = await db.prepare('SELECT completed FROM family_school_week_dates WHERE id = ?').get(dateA.id);
  assert.equal(row.completed, true);

  const page = await request(app).get(`/parent/family-school/weekly-planner?owner=parent&weekId=${weekId}`).set('Cookie', parent.cookie);
  const dayCheckboxMatch = /<input type="checkbox" class="fs-weekly-plan-day-complete-checkbox" checked onchange="this\.form\.requestSubmit\(\)"/.exec(page.text);
  assert.ok(dayCheckboxMatch, 'expected the day-complete checkbox to render checked');
});

// A real request: "Weekly planner, day completed check box should be on
// the title bar next to each date. Only parents can see this check box,
// not student portal. When parent checks this box, the student portal
// will say, complete with a check mark."
test('the day-complete checkbox lives in the day title bar for parents; students never see it, only a Complete badge once checked', async () => {
  const familyId = await createFamily('Title Bar Family');
  const parent = await createParent(familyId);
  const student = await createStudent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'family', studentId: null, title: 'Title Bar Week', dates: ['2027-01-04'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);

  const parentPageBefore = await request(app).get(`/parent/family-school/weekly-planner?owner=family&weekId=${weekId}`).set('Cookie', parent.cookie);
  assert.match(parentPageBefore.text, /<div class="fs-weekly-plan-day-title-row">[\s\S]*?<span>[\s\S]*?<\/span>[\s\S]*?fs-weekly-plan-day-complete-checkbox/, 'checkbox should sit in the same title-row block as the date, not a separate "Day complete" row below');
  assert.doesNotMatch(parentPageBefore.text, /checkbox-option fs-weekly-plan-day-complete"/, 'the old separate "Day complete" checkbox+label row should be gone');

  const studentPageBefore = await request(app).get(`/student/family-school/weekly-planner?weekId=${weekId}`).set('Cookie', student.cookie);
  assert.equal(studentPageBefore.status, 200);
  assert.doesNotMatch(studentPageBefore.text, /fs-weekly-plan-day-complete-checkbox/, 'students must never see the day-complete checkbox');
  assert.doesNotMatch(studentPageBefore.text, />Complete</, 'no Complete badge yet - the day is not marked complete');

  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/weekly-planner');
  await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/toggle-complete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: csrf });

  const studentPageAfter = await request(app).get(`/student/family-school/weekly-planner?weekId=${weekId}`).set('Cookie', student.cookie);
  assert.doesNotMatch(studentPageAfter.text, /fs-weekly-plan-day-complete-checkbox/, 'still read-only for students after the parent checks it');
  assert.match(studentPageAfter.text, /<span class="badge-pill badge-pill-green"><svg class="icon"><use href="#icon-check"\/><\/svg> Complete<\/span>/);
});

test('a parent from a different family cannot toggle another family\'s assignment or day complete', async () => {
  const familyId = await createFamily('Owner Family');
  const owner = await createParent(familyId);
  const weekId = await createWeek({ familyId, ownerType: 'parent', studentId: null, title: 'Owner Week', dates: ['2026-12-28'], createdByAccountId: null });
  const [dateA] = await db.prepare('SELECT id FROM family_school_week_dates WHERE week_id = ?').all(weekId);
  const assignmentId = await createWeekAssignment({ weekDateId: dateA.id, subject: 'Math', title: 'Owner Assignment', contentItemId: null });

  const otherFamilyId = await createFamily('Outsider Family');
  const outsider = await createParent(otherFamilyId);

  const csrf = await csrfFrom(outsider.cookie, '/parent/family-school/weekly-planner');
  const assignmentRes = await request(app)
    .post(`/parent/family-school/weekly-planner/assignments/${assignmentId}/toggle-complete`)
    .set('Cookie', outsider.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(assignmentRes.status, 404);

  const dateRes = await request(app)
    .post(`/parent/family-school/weekly-planner/dates/${dateA.id}/toggle-complete`)
    .set('Cookie', outsider.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(dateRes.status, 404);

  const row = await db.prepare('SELECT completed FROM family_school_week_assignments WHERE id = ?').get(assignmentId);
  assert.equal(row.completed, false);
  void owner;
});

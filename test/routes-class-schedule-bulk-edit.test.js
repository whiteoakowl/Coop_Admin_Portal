// A real request: "Add bulk edit button on classes, class schedules...
// When you click bulk edit it will show a check mark on the left next to
// each member in list view and a select all button. Bulk edit button then
// says bulk edit selected classes. One form popsup showing title, room
// number, class start time and end time, open and close class check
// boxes, description, class start date, class end date, class semester
// selection." Covers the server-rendered markup (checkboxes/toggle/dialog)
// and, most importantly, the actual bulk-save route: a blank field must
// leave that column alone on every selected class rather than clobbering
// it, per utils/classSchedule.js's own bulkUpdateClasses comment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-bulk-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-bulk-edit-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, getClass } = require('../utils/classSchedule');

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

test('List view renders a Bulk Edit toggle, a per-class checkbox, and the bulk-edit dialog with every requested field', async () => {
  const admin = await loginAsAdmin();
  await createClass({ day: 'monday', hourPosition: 1, className: 'Bulk Edit Markup Class', room: 'Room A' });

  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.match(page.text, /data-bulk-edit-toggle="class-bulk-edit-form-monday"/);
  assert.match(page.text, /name="classIds" value="\d+" form="class-bulk-edit-form-monday"/);
  assert.match(page.text, /id="bulk-edit-dialog-monday"/);
  assert.match(page.text, /name="className" placeholder="Don't change"/);
  assert.match(page.text, /name="room"/);
  assert.match(page.text, /name="startTime"/);
  assert.match(page.text, /name="endTime"/);
  assert.match(page.text, /name="openClass"/);
  assert.match(page.text, /name="closeClass"/);
  assert.match(page.text, /name="description"/);
  assert.match(page.text, /name="startDate"/);
  assert.match(page.text, /name="endDate"/);
  assert.match(page.text, /name="semesterId"/);
  // A real bug: archive-select-toggle.js (which powers the Select All
  // checkbox's own change handler) was never included on this page, so
  // Select All checked nothing and a 2nd Bulk Edit click always saw zero
  // selected classes and silently cancelled instead of opening the dialog.
  assert.match(page.text, /<script src="\/js\/archive-select-toggle\.js">/);
});

// A real request: "when clicking bulk edit for classes, check boxes should
// appear on each class as well so a select few can be chosen" - Bulk Edit
// used to only put a per-class checkbox on the List view's own rows, with
// nothing to check while Grid view (the default) was showing. The Grid
// card's own checkbox shares the exact same name/value/form attribute as
// the List row's, so Select All and the Bulk Edit toggle (both of which
// just query every checkbox tied to the form) already pick it up with no
// JS changes needed.
test('Grid view cards also get their own per-class Bulk Edit checkbox', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Grid Checkbox Class', room: 'Room A' });

  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  const gridCheckboxRe = new RegExp(`<input type="checkbox" class="class-card-checkbox" name="classIds" value="${classId}" form="class-bulk-edit-form-monday"`);
  assert.match(page.text, gridCheckboxRe, 'the Grid card should carry its own checkbox, wired to the same bulk-edit form as the List row');

  // Both the Grid card's checkbox and the List row's checkbox for this same
  // class must be present at once (both views are always rendered; only
  // which one is visible is a client-side CSS toggle) - Select All has to
  // reach both.
  const matches = page.text.match(new RegExp(`name="classIds" value="${classId}" form="class-bulk-edit-form-monday"`, 'g')) || [];
  assert.equal(matches.length, 2, 'one checkbox from the Grid card and one from the List row');
});

test('bulk-editing a blank field leaves that column alone on every selected class', async () => {
  const admin = await loginAsAdmin();
  const classA = await createClass({ day: 'monday', hourPosition: 1, className: 'Keep My Room A', room: 'Room A', description: 'Original description A' });
  const classB = await createClass({ day: 'monday', hourPosition: 2, className: 'Keep My Room B', room: 'Room B', description: 'Original description B' });

  // Only the title is filled in - room and description must survive untouched.
  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA},${classB}`, className: 'Bulk Renamed', room: '', description: '' });

  const a = await getClass(classA);
  const b = await getClass(classB);
  assert.equal(a.class_name, 'Bulk Renamed');
  assert.equal(b.class_name, 'Bulk Renamed');
  assert.equal(a.room, 'Room A', 'room must be untouched when the bulk-edit field was left blank');
  assert.equal(b.room, 'Room B', 'room must be untouched when the bulk-edit field was left blank');
  assert.equal(a.description, 'Original description A');
  assert.equal(b.description, 'Original description B');
});

test('bulk-editing Open Class / Close Class sets registration_open across every selected class', async () => {
  const admin = await loginAsAdmin();
  const classA = await createClass({ day: 'monday', hourPosition: 1, className: 'Open Close A', registrationOpen: true });
  const classB = await createClass({ day: 'monday', hourPosition: 2, className: 'Open Close B', registrationOpen: true });

  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA},${classB}`, closeClass: '1' });

  assert.equal((await getClass(classA)).registration_open, 0);
  assert.equal((await getClass(classB)).registration_open, 0);

  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA},${classB}`, openClass: '1' });

  assert.equal((await getClass(classA)).registration_open, 1);
  assert.equal((await getClass(classB)).registration_open, 1);
});

test('bulk-editing the semester: a real id sets it, "No Semester" clears it, and leaving it blank changes nothing', async () => {
  const admin = await loginAsAdmin();
  const semester = await db.prepare('INSERT INTO semesters (title) VALUES (?) RETURNING *').get('Spring 2028');
  const classA = await createClass({ day: 'monday', hourPosition: 1, className: 'Semester Bulk A', semesterId: null });
  const classB = await createClass({ day: 'monday', hourPosition: 2, className: 'Semester Bulk B', semesterId: null });

  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA},${classB}`, semesterId: String(semester.id) });
  assert.equal((await getClass(classA)).semester_id, semester.id);
  assert.equal((await getClass(classB)).semester_id, semester.id);

  // Blank ("Don't change") leaves it exactly as-is.
  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA},${classB}`, className: 'Still Semester Bulk A' });
  assert.equal((await getClass(classA)).semester_id, semester.id, 'semester must be untouched when the dropdown was left on "Don\'t change"');

  // "No Semester" explicitly clears it.
  await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken, classIds: `${classA}`, semesterId: 'none' });
  assert.equal((await getClass(classA)).semester_id, null);
  assert.equal((await getClass(classB)).semester_id, semester.id, 'clearing class A must not affect class B');
});

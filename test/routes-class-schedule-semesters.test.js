// A real request: "Overall class settings. Add a place to create and add
// new semester titles. On individual class settings add dropdown for
// choosing semester." Covers: the Settings tab's new Semesters section
// (add/list/delete), and each class's own Semester dropdown on that same
// tab (rendered pre-selected + saved through the existing per-class
// settings auto-save route, same as the registration/cancellation
// checkboxes it sits beside).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-semesters-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-semesters-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Settings tab has an Add a Semester form, and added semesters are listed with a Delete button', async () => {
  const admin = await loginAsAdmin();

  // A real request: "Add a semester settings should be under the gear
  // settings icon at the top" - moved from Classes > Settings > Semester
  // to /admin/settings (routes/admin.js's own 'semesters' tab).
  const before = await request(app).get('/admin/settings?tab=semesters').set('Cookie', admin.cookie);
  assert.match(before.text, /<h2>Semesters<\/h2>/);
  assert.match(before.text, /Add a Semester/);
  assert.match(before.text, /No semesters yet\./);

  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall 2026', _csrf: admin.csrfToken });

  const after = await request(app).get('/admin/settings?tab=semesters').set('Cookie', admin.cookie);
  assert.match(after.text, /Fall 2026/);
  assert.match(after.text, /admin\/schedule\/semesters\/\d+\/delete/);

  const semester = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Fall 2026');
  assert.ok(semester, 'semester should have been created');

  await request(app)
    .post(`/admin/schedule/semesters/${semester.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  const gone = await db.prepare('SELECT * FROM semesters WHERE id = ?').get(semester.id);
  assert.equal(gone, undefined);
});

test("Each class's own Details tab gets a Semester dropdown, pre-selected to its own semester, listing every semester as an option", async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Spring 2027', _csrf: admin.csrfToken });
  const semester = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Spring 2027');

  // A real bug report ("there are currently many people signed up for
  // fall 2026 classes. They aren't showing on this orientation list")
  // means a brand new class no longer starts with NO semester - it
  // defaults to whichever semester is currently the most-recently-
  // created one (see createClass's own comment in utils/classSchedule.js) -
  // Spring 2027 here, since it's the only one that exists yet.
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Semester Dropdown Class' });
  const clsOnCreate = await getClass(classId);
  assert.equal(clsOnCreate.semester_id, semester.id, 'a brand new class should default to the current semester, not none');

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  assert.match(page.text, /<select name="semesterId">/);
  assert.match(page.text, /<option value="">No Semester<\/option>/);
  assert.match(page.text, new RegExp(`<option value="${semester.id}" selected>Spring 2027</option>`));

  // Explicitly choosing a DIFFERENT semester still works as before.
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall 2027', _csrf: admin.csrfToken });
  const laterSemester = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Fall 2027');

  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Semester Dropdown Class', hourPosition: '1', semesterId: String(laterSemester.id), _csrf: admin.csrfToken });

  const cls = await getClass(classId);
  assert.equal(cls.semester_id, laterSemester.id);

  const afterAssign = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  assert.match(afterAssign.text, new RegExp(`<option value="${laterSemester.id}" selected>Fall 2027</option>`));

  // Clearing it back to "No Semester" (empty value) should null it out.
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Semester Dropdown Class', hourPosition: '1', semesterId: '', _csrf: admin.csrfToken });
  const clsAfterClear = await getClass(classId);
  assert.equal(clsAfterClear.semester_id, null);
});

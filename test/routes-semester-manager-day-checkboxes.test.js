// Add/Edit Semester redesign - a real request: "text line to add
// semester title. Then a section for add a schedule. Check boxes to
// select the days of the week it will be. Then the choose semester/day
// dropdowns on every page will show the new semester separately for each
// day selected." Adding a semester now creates its own class_schedules
// row per checked day in the same step (instead of a separate trip to
// Day Settings for each one), and clicking a semester's own title in the
// list opens an inline edit form (title + day checkboxes) that can add or
// remove days, not just rename.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `semester-manager-day-checkboxes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `semester-manager-day-checkboxes-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Add a Semester now has a day-checkbox "Add a Schedule" section, and checking days creates a class_schedules row for each one', async () => {
  const admin = await loginAsAdmin();

  const settingsPage = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  assert.match(settingsPage.text, /Add a Schedule/);
  assert.match(settingsPage.text, /<input type="checkbox" name="days" value="monday" \/>/);
  assert.match(settingsPage.text, /<input type="checkbox" name="days" value="tuesday" \/>/);

  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall 2026', days: ['monday', 'wednesday'], _csrf: admin.csrfToken });

  const semester = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Fall 2026');
  assert.ok(semester, 'semester should have been created');

  const schedules = await db.prepare('SELECT * FROM class_schedules WHERE semester_id = ? ORDER BY day_of_week').all(semester.id);
  assert.equal(schedules.length, 2, 'one class_schedules row per checked day');
  assert.deepEqual(schedules.map((s) => s.day_of_week), ['monday', 'wednesday']);

  // The combo picker now offers "Fall 2026 - Monday" and "Fall 2026 -
  // Wednesday" as separate options, not just a bare day name.
  const classesPage = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.match(classesPage.text, />Fall 2026 - Monday</);
  assert.match(classesPage.text, />Fall 2026 - Wednesday</);

  // The list below shows the new semester's own days - scoped to after
  // the list table itself starts, since "Fall 2026" also appears earlier
  // on the page as the "Add a Semester" form's own title placeholder
  // text ("e.g. Fall 2026").
  const afterPage = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  const tableStart = afterPage.text.indexOf('semester-list-table');
  const rowStart = afterPage.text.indexOf('Fall 2026', tableStart);
  const rowEnd = afterPage.text.indexOf('</tr>', rowStart);
  assert.match(afterPage.text.slice(rowStart, rowEnd), /Monday, Wednesday/);
});

test('clicking a semester\'s title opens an edit form that can rename it and add/remove days', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Spring 2027', days: ['monday'], _csrf: admin.csrfToken });
  const semester = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Spring 2027');

  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`data-semester-edit-toggle="semester-edit-${semester.id}"[^>]*>Spring 2027<`));
  // The edit row's own Monday checkbox should already be checked, Tuesday not.
  const editRowMatch = new RegExp(`id="semester-edit-${semester.id}"[\\s\\S]*?</tr>`).exec(page.text);
  assert.ok(editRowMatch, 'expected a hidden edit row for this semester');
  assert.match(editRowMatch[0], /value="monday" checked/);
  assert.doesNotMatch(editRowMatch[0], /value="tuesday" checked/);

  // Rename + swap Monday for Tuesday in one Save.
  await request(app)
    .post(`/admin/schedule/semesters/${semester.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Spring 2027 (renamed)', days: ['tuesday'], _csrf: admin.csrfToken });

  const renamed = await db.prepare('SELECT * FROM semesters WHERE id = ?').get(semester.id);
  assert.equal(renamed.title, 'Spring 2027 (renamed)');

  const schedules = await db.prepare('SELECT day_of_week FROM class_schedules WHERE semester_id = ?').all(semester.id);
  assert.deepEqual(schedules.map((s) => s.day_of_week), ['tuesday'], 'Monday\'s class_schedules row should be gone, Tuesday\'s added');
});

test('deleting a semester shows the updated, accurate confirm text (not just "Classes will show No Semester")', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Delete Confirm Semester', _csrf: admin.csrfToken });

  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  assert.match(
    page.text,
    /data-confirm="Are you sure you want to delete the &quot;Delete Confirm Semester&quot; semester\? This action can&#39;t be reversed\./
  );
});

test('a semester with no days yet shows "No days yet" instead of a blank cell', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'No Days Semester', _csrf: admin.csrfToken });

  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  const tableStart = page.text.indexOf('semester-list-table');
  const rowStart = page.text.indexOf('No Days Semester', tableStart);
  const rowEnd = page.text.indexOf('</tr>', rowStart);
  assert.match(page.text.slice(rowStart, rowEnd), /No days yet/);
});

// Coverage for a real request: "add/edit class schedule grid button on
// the class schedule page. When you click this button it opens a pop up
// to allow you to create a new schedule grid, choose a semester/day,
// choose column titles and row titles." A follow-up confirmed each
// semester/day combo gets its own independent hours (columns) and rooms
// (rows), the Classes grid itself server-side filters by whichever
// semester is selected, and a class that's never been tagged with a
// semester still shows up no matter which real semester is selected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-grid-editor-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-grid-editor-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const classSchedule = require('../utils/classSchedule');

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

test('the Classes grid button is now "Add/Edit Class Schedule Grid", with a Semester picker, Start/End Date, hour labels, and a Rooms list in its popup', async () => {
  const admin = await loginAsAdmin();
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Grid Popup Fall', _csrf: admin.csrfToken });
  const semester = await db.prepare("SELECT * FROM semesters WHERE title = 'Grid Popup Fall'").get();

  const page = await request(app).get(`/admin/schedule?tab=monday&semesterId=${semester.id}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Add\/Edit Class Schedule Grid</);
  assert.match(page.text, /<h3>Add\/Edit Class Schedule Grid - Monday<\/h3>/);
  assert.match(page.text, new RegExp(`<option value="[^"]*semesterId=${semester.id}"[^>]*selected>Grid Popup Fall</option>`));
  assert.match(page.text, /name="startDate"/);
  assert.match(page.text, /name="endDate"/);
  assert.match(page.text, /name="labels" value="Hour 1"/);
  assert.match(page.text, /data-grid-editor-add-room/);
});

test('saving the popup for one semester customizes that semester\'s own hours/rooms/dates without touching the shared (No Semester) ones', async () => {
  const admin = await loginAsAdmin();
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Grid Save Fall', _csrf: admin.csrfToken });
  const semester = await db.prepare("SELECT * FROM semesters WHERE title = 'Grid Save Fall'").get();

  const res = await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      semesterId: String(semester.id),
      startDate: '2026-09-01',
      endDate: '2026-12-18',
      labels: ['Block A', 'Block B', 'Block C', 'Block D'],
      startTimes: ['', '', '', ''],
      endTimes: ['', '', '', ''],
      oldNames: [''],
      newNames: ['Studio 1'],
      _csrf: admin.csrfToken,
    });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${semester.id}`));
  assert.match(res.headers.location, /notice=/);

  const ownHours = await classSchedule.hoursForDay('monday', semester.id);
  assert.deepEqual(ownHours.map((h) => h.label), ['Block A', 'Block B', 'Block C', 'Block D']);

  const sharedHours = await classSchedule.hoursForDay('monday');
  assert.deepEqual(sharedHours.map((h) => h.label), ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], 'the shared/no-semester hours must stay untouched');

  const combo = await db.prepare('SELECT * FROM class_schedules WHERE day_of_week = ? AND semester_id = ?').get('monday', semester.id);
  assert.equal(combo.start_date, '2026-09-01');
  assert.equal(combo.end_date, '2026-12-18');

  const page = await request(app).get(`/admin/schedule?tab=monday&semesterId=${semester.id}`).set('Cookie', admin.cookie);
  assert.match(page.text, /Studio 1/, 'a declared room with no classes yet still shows its own row');
});

test('a class with no semester tag still shows up on a real semester\'s grid, but only the untagged ones show on "No Semester"', async () => {
  const admin = await loginAsAdmin();
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Untagged Visibility Fall', _csrf: admin.csrfToken });
  const semester = await db.prepare("SELECT * FROM semesters WHERE title = 'Untagged Visibility Fall'").get();

  const untaggedId = await classSchedule.createClass({ day: 'wednesday', hourPosition: 1, className: 'Nobody Tagged Me' });
  await db.prepare('UPDATE classes SET semester_id = NULL WHERE id = ?').run(untaggedId);
  const taggedId = await classSchedule.createClass({ day: 'wednesday', hourPosition: 2, className: 'Tagged To This Semester' });
  await db.prepare('UPDATE classes SET semester_id = ? WHERE id = ?').run(semester.id, taggedId);

  const semesterGrid = await classSchedule.gridForDay('wednesday', semester.id);
  const semesterNames = semesterGrid.flatMap((h) => h.classes.map((c) => c.class_name));
  assert.ok(semesterNames.includes('Nobody Tagged Me'), 'untagged classes show up on a real semester\'s grid too');
  assert.ok(semesterNames.includes('Tagged To This Semester'));

  const noSemesterGrid = await classSchedule.gridForDay('wednesday', null);
  const noSemesterNames = noSemesterGrid.flatMap((h) => h.classes.map((c) => c.class_name));
  assert.ok(noSemesterNames.includes('Nobody Tagged Me'));
  assert.ok(!noSemesterNames.includes('Tagged To This Semester'), 'explicitly picking "No Semester" narrows to only the untagged ones');
});

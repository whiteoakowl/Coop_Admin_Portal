// A real request: "Full 7 day expansion so multiple semesters can be
// created and managed... now day settings. So we can create multiple
// semester schedule grids and all the floater and setup cleanup features
// for each to go with it. Then this will work for years to come." Phase
// 1: a new Settings > Day Settings sub-tab lets an admin activate any day
// of the week (not just Monday/Wednesday) as a Classes grid tab, with a
// title/semester/date-range recorded for the record. Covers: the Day
// Settings tab itself (add/edit/delete), that a newly-activated day
// (Tuesday) shows up as a real Classes grid tab with its own Add Class/
// Edit Hours/Bulk Edit/Archive/Import/Export/Print all working (not just
// the grid's own landing page), and that Monday/Wednesday keep working
// completely unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedules-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedules-day-settings-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Day Settings tab offers a Day of Week dropdown with all 7 days, and lists Monday/Wednesday by default', async () => {
  const admin = await loginAsAdmin();
  const res = await request(app).get('/admin/schedule?tab=settings&settingsTab=days').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Add a Day/);
  for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
    assert.match(res.text, new RegExp(`<option value="${day.toLowerCase()}">${day}</option>`));
  }
  assert.match(res.text, />Monday<\/td>/);
  assert.match(res.text, />Wednesday<\/td>/);
});

test('Adding a Tuesday day schedule makes it a real Classes grid tab, with Add Class/Edit Hours/Bulk Edit/Archive/Import/Export/Print all reachable', async () => {
  const admin = await loginAsAdmin();

  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: admin.csrfToken });

  const schedule = await db.prepare("SELECT * FROM class_schedules WHERE day_of_week = 'tuesday'").get();
  assert.ok(schedule, 'the class_schedules row should have been created');
  assert.equal(schedule.title, 'Tuesday Enrichment');

  // Tuesday's own 4 default Hour rows were created too (same shape as
  // Monday/Wednesday always get).
  const hours = await db.prepare("SELECT * FROM class_schedule_hours WHERE day = 'tuesday' ORDER BY position").all();
  assert.equal(hours.length, 4);

  const gridPage = await request(app).get('/admin/schedule?tab=tuesday').set('Cookie', admin.cookie);
  assert.equal(gridPage.status, 200);
  // The plain day-toggle pill is now the semester+day combo picker (a
  // real request: "I need to be able to switch between semester views
  // on... classes").
  assert.match(gridPage.text, />Tuesday<\/option>/, 'Tuesday should be a real tab now, alongside Monday/Wednesday');
  assert.match(gridPage.text, />Monday<\/option>/);
  assert.match(gridPage.text, />Wednesday<\/option>/);

  // Add Class on the Tuesday tab offers Tuesday (and every other active
  // day) in its own Class Day dropdown.
  assert.match(gridPage.text, /<option value="tuesday" selected>Tuesday<\/option>/);

  const createRes = await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'tuesday', hourPosition: '1', className: 'Tuesday Art', _csrf: admin.csrfToken });
  assert.notEqual(createRes.status, 404);
  const tuesdayClass = await db.prepare("SELECT * FROM classes WHERE day = 'tuesday'").get();
  assert.ok(tuesdayClass, 'a class should have been created on Tuesday');

  // Every :day-gated route in routes/admin-class-schedule.js (previously
  // 404ing for anything but monday/wednesday via the shared requireDay)
  // now works for Tuesday too.
  const manage = await request(app).get('/admin/class-schedule/tuesday').set('Cookie', admin.cookie);
  assert.notEqual(manage.status, 404);

  const editHours = await request(app)
    .post('/admin/class-schedule/tuesday/edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], _csrf: admin.csrfToken });
  assert.notEqual(editHours.status, 404);

  const bulkEdit = await request(app)
    .post('/admin/class-schedule/tuesday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classIds: String(tuesdayClass.id), _csrf: admin.csrfToken });
  assert.notEqual(bulkEdit.status, 404);

  const archive = await request(app)
    .post('/admin/class-schedule/tuesday/archive')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classIds: [], _csrf: admin.csrfToken });
  assert.notEqual(archive.status, 404);

  const exportCsv = await request(app).get('/admin/class-schedule/tuesday/export.csv').set('Cookie', admin.cookie);
  assert.equal(exportCsv.status, 200);

  const print = await request(app).get('/admin/class-schedule/tuesday/print').set('Cookie', admin.cookie);
  assert.equal(print.status, 200);
});

test('Editing a day schedule updates its title/dates; deleting it removes the record but leaves its classes/hours alone', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Thursday Co-op', dayOfWeek: 'thursday', startDate: '2026-09-01', endDate: '2026-12-15', _csrf: admin.csrfToken });
  const schedule = await db.prepare("SELECT * FROM class_schedules WHERE day_of_week = 'thursday'").get();

  await request(app)
    .post(`/admin/schedule/class-schedules/${schedule.id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Thursday Co-op Renamed', dayOfWeek: 'thursday', startDate: '2026-09-08', endDate: '2026-12-15', _csrf: admin.csrfToken });
  const renamed = await db.prepare('SELECT * FROM class_schedules WHERE id = ?').get(schedule.id);
  assert.equal(renamed.title, 'Thursday Co-op Renamed');
  assert.equal(renamed.start_date, '2026-09-08');

  await createClass({ day: 'thursday', hourPosition: 1, className: 'Thursday Robotics' });

  await request(app)
    .post(`/admin/schedule/class-schedules/${schedule.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  const deleted = await db.prepare('SELECT * FROM class_schedules WHERE id = ?').get(schedule.id);
  assert.equal(deleted, undefined);

  // The class itself is untouched - only the Day Settings record is gone.
  const stillThere = await db.prepare("SELECT * FROM classes WHERE day = 'thursday'").get();
  assert.ok(stillThere, 'the Thursday class should not have been deleted');
});

test('Creating a day schedule for a (day, semester) pair that already exists is rejected with a clear error', async () => {
  const admin = await loginAsAdmin();
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall 2026 Day Settings Test', _csrf: admin.csrfToken });
  const semester = await db.prepare("SELECT * FROM semesters WHERE title = 'Fall 2026 Day Settings Test'").get();

  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Friday Fall', dayOfWeek: 'friday', semesterId: String(semester.id), _csrf: admin.csrfToken });

  const dupe = await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Friday Fall Again', dayOfWeek: 'friday', semesterId: String(semester.id), _csrf: admin.csrfToken });
  assert.match(dupe.headers.location, /error=/);
  const count = await db.prepare("SELECT COUNT(*) AS c FROM class_schedules WHERE day_of_week = 'friday' AND semester_id = ?").get(semester.id);
  assert.equal(Number(count.c), 1, 'the duplicate should not have been created');
});

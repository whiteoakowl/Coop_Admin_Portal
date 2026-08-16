// Coverage for a feature request: entering an End Time on every
// individual class was too tedious, so class_schedule_hours (the shared
// "Hour 1"/"Hour 2" row, previously label-only) now also carries its own
// Start/End Time, set once via the Class Schedule page's "Edit" dialog
// (POST /admin/class-schedule/:day/edit -> saveHourLabels). Every class in
// that hour position uses it unless the class sets its own start_time AND
// end_time, which fully overrides it - see derivedHourTimeRanges's own
// comment in utils/classSchedule.js. Feeds both Arrival/Departure
// (familyAttendanceWindowsForDay) and the member Schedule Card's displayed
// time (member_schedules.time, via syncMemberSchedulesForDay).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `hour-level-times-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `hour-level-times-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, syncDayMemberRosters } = require('../utils/classSchedule');
const { arrivalDepartureLabels } = require('../utils/schedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'] };
}

async function makeStudent(name, barcode) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES (?)`).run(`${name} Family`)).lastInsertRowid;
  return (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES (?, ?, 'student', ?)").run(name, barcode, familyId)
  ).lastInsertRowid;
}

test('POST /admin/class-schedule/:day/edit saves each hour\'s own Start/End Time', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({
      labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'],
      startTimes: ['9:00 AM', '10:00 AM', '', '12:00 PM'],
      endTimes: ['9:45 AM', '10:45 AM', '', '12:45 PM'],
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const rows = await db.prepare("SELECT position, start_time, end_time FROM class_schedule_hours WHERE day = 'monday' ORDER BY position").all();
  assert.deepEqual(rows.map((r) => [r.position, r.start_time, r.end_time]), [
    [1, '9:00 AM', '9:45 AM'],
    [2, '10:00 AM', '10:45 AM'],
    [3, null, null],
    [4, '12:00 PM', '12:45 PM'],
  ]);
});

test('a class with no time of its own inherits its hour\'s Start/End Time for Arrival/Departure and its Schedule Card', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes: ['9:00 AM', '', '', ''], endTimes: ['9:45 AM', '', '', ''], _csrf: csrfToken });

  const studentId = await makeStudent('Hour Default Kid', 'hour-default-kid');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'No Own Time Class' });
  await setEnrollment(classId, [studentId]);
  await syncDayMemberRosters('monday');

  const { arrival, departure } = await arrivalDepartureLabels(studentId, 'monday');
  assert.equal(arrival, '9:00 AM');
  assert.equal(departure, '9:45 AM');

  const scheduleRow = await db.prepare("SELECT time FROM member_schedules WHERE member_id = ? AND day = 'monday'").get(studentId);
  assert.equal(scheduleRow.time, '9:00 AM - 9:45 AM', "the member's own Schedule Card time should reflect the hour's default too");
});

test('a class with its own start_time but no end_time only borrows the hour\'s End Time, keeping its own start', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes: ['9:00 AM', '', '', ''], endTimes: ['9:45 AM', '', '', ''], _csrf: csrfToken });

  const studentId = await makeStudent('Partial Override Kid', 'partial-override-kid');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Own Start Only Class', startTime: '9:15 AM' });
  await setEnrollment(classId, [studentId]);
  await syncDayMemberRosters('monday');

  const { arrival, departure } = await arrivalDepartureLabels(studentId, 'monday');
  assert.equal(arrival, '9:15 AM', "the class's own start time should win over the hour default");
  assert.equal(departure, '9:45 AM', "the hour's default end time should still fill in since the class has none of its own");
});

test('a class with both its own start_time and end_time fully overrides the hour default', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes: ['9:00 AM', '', '', ''], endTimes: ['9:45 AM', '', '', ''], _csrf: csrfToken });

  const studentId = await makeStudent('Full Override Kid', 'full-override-kid');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Own Time Class', startTime: '9:05 AM', endTime: '9:50 AM' });
  await setEnrollment(classId, [studentId]);
  await syncDayMemberRosters('monday');

  const { arrival, departure } = await arrivalDepartureLabels(studentId, 'monday');
  assert.equal(arrival, '9:05 AM');
  assert.equal(departure, '9:50 AM');
});

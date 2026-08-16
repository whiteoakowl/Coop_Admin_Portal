// Coverage for a live bug report: every family's Arrival/Departure was
// synching off "one longer class" - a genuinely longer class (e.g. a
// 90-minute double period) sharing an hour position with normal-length
// classes in other rooms was polluting that WHOLE position's derived time
// range, so every OTHER family in that hour inherited the long class's end
// time instead of their own class's real, shorter one. Root cause: both
// derivedHourTimeRanges (the position-level "earliest start_time wins, use
// THAT class's own end_time" guess) and the family-window computation fed
// off that single shared, contaminated value. Fixed two ways -
// derivedHourTimeRanges now gives the hour row's own shared Start/End Time
// outright priority over any one class's start_time when the hour has its
// own set, and the family-window computation (effectiveClassRange in
// ownPositionsAndFamilyWindowsForDay) uses each member's own SPECIFIC
// class's effective time instead of the shared per-position guess at all,
// so a real per-class override only ever affects that class's own family,
// never anyone else sharing the same hour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `longer-class-contamination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `longer-class-contamination-test-uploads-${process.pid}`);
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

test('a longer class sharing an hour with normal classes does not contaminate other families\' Departure', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes: ['10:00 AM', '', '', ''], endTimes: ['10:45 AM', '', '', ''], _csrf: csrfToken });

  // A normal, hour-default-only class...
  const normalKidId = await makeStudent('Normal Length Kid', 'normal-length-kid');
  const normalClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Normal Class', room: 'Room A' });
  await setEnrollment(normalClassId, [normalKidId]);

  // ...sharing Hour 1 with a genuinely longer, fully-overridden class in a
  // different room (a real "double period" - both its own start_time and
  // end_time set, spanning what would normally be Hour 1 AND Hour 2).
  const longKidId = await makeStudent('Long Class Kid', 'long-class-kid');
  const longClassId = await createClass({
    day: 'monday',
    hourPosition: 1,
    className: 'Long Double-Period Class',
    room: 'Room B',
    startTime: '10:00 AM',
    endTime: '11:30 AM',
  });
  await setEnrollment(longClassId, [longKidId]);
  await syncDayMemberRosters('monday');

  const normalLabels = await arrivalDepartureLabels(normalKidId, 'monday');
  const longLabels = await arrivalDepartureLabels(longKidId, 'monday');

  assert.deepEqual(normalLabels, { arrival: '10:00 AM', departure: '10:45 AM' }, 'the normal-length class\'s own family must not inherit the long class\'s later end time');
  assert.deepEqual(longLabels, { arrival: '10:00 AM', departure: '11:30 AM' }, 'the long class\'s own family should still correctly see its real, longer departure');
});

// Real HTTP-level coverage locking in existing (and easy to accidentally
// regress) behavior: importing a Student Schedule row (Schedules ->
// Student Schedules -> Import, routes/admin-schedule.js's
// POST /admin/schedule/:tab/import) doesn't just record the enrollment -
// it has to actually land the student on that specific class's roster
// (roster_members, via utils/classSchedule.js's setEnrollment ->
// syncClassRosterMembers) AND on the day's own Student roster the main
// dashboard/attendance page reads from (syncDayMemberRosters), or "import
// a schedule" wouldn't actually get anyone checked in on class day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-import-roster-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-import-roster-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const XLSX = require('xlsx');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

function buildImportBuffer(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('importing a Student Schedule row enrolls the student on the class roster and the day roster', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Roster Test Kid', memberType: 'student', _csrf: csrfToken });

  const classBuffer = buildImportBuffer(
    ['Day', 'Hour', 'Class Name', 'Room', 'Age Group'],
    [['Monday', '1', 'Import Roster Class', 'Room 1', 'All Ages']]
  );
  await request(app)
    .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', classBuffer, 'classes.xlsx');
  const cls = db.prepare("SELECT * FROM classes WHERE class_name = 'Import Roster Class'").get();
  assert.ok(cls, 'setup: the class should exist before importing a schedule row for it');

  await t.test('the schedule import puts the student on both the class roster and the day-level Student roster', async () => {
    const scheduleBuffer = buildImportBuffer(
      ['Member Name', 'Day', 'Class Name', 'Start Time'],
      [['Roster Test Kid', 'Monday', 'Import Roster Class', '']]
    );
    const res = await request(app)
      .post('/admin/schedule/students/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', scheduleBuffer, 'schedule.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Matched 1 schedule row'));

    const student = db.prepare("SELECT id FROM members WHERE name = 'Roster Test Kid'").get();

    // On the class's own roster (Class Roster - what Class Check-In and
    // the class's attendance sheet read from).
    const onClassRoster = db
      .prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?')
      .get(cls.roster_id, student.id);
    assert.ok(onClassRoster, 'the student should be on the class\'s own roster after import');

    // On Monday's day-level Student roster (what the main dashboard /
    // Attendance page reads from for "who's expected Monday").
    const mondayStudentRosterId = db.prepare("SELECT value FROM app_settings WHERE key = 'monday_student_roster_id'").get();
    assert.ok(mondayStudentRosterId, 'setup: the day-level Monday Student roster should already exist');
    const onDayRoster = db
      .prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?')
      .get(mondayStudentRosterId.value, student.id);
    assert.ok(onDayRoster, 'the student should also be on Monday\'s day-level Student roster after import, not just the class roster');
  });
});

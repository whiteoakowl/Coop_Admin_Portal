// Coverage for the actual root cause behind a recurring live bug report:
// "the Attendance roster's Arrival/Departure shows the same time for
// everyone, no matter how many classes they're actually on." Every prior
// attempt to fix this (see MIGRATION.md/git history - "Compute
// Arrival/Departure per-individual", "Fix a longer class contaminating
// every other family's arrival/departure", the self-healing-floater
// commits, etc.) fixed a real bug in how the window is COMPUTED from a
// member's real class_enrollments/class_staff rows - but the actual
// live-reported case turned out to be one step earlier: those rows were
// never created in the first place, because a real spreadsheet (not a
// hand-typed CSV) stores a typed time like "10:00 AM" as a numeric
// time-of-day serial with a Time number format, not the text "10:00 AM" -
// and routes/admin-schedule.js's Student/Parent Schedule import silently
// drops a class match whose Start Time field doesn't textually match the
// class's own stored start_time, which a raw numeric serial (or even
// formatted text that includes seconds, e.g. Excel's h:mm:ss AM/PM ->
// "10:00:00 AM") never does.
//
// Two fixes, two levels of test here:
//   1. utils/spreadsheetWorker.js now reads cells' FORMATTED text
//      (raw: false) instead of the raw underlying value - see
//      test/spreadsheet.test.js for direct coverage of that half.
//   2. Every parseClockMinutes/parseClockMinutesLocal copy (there are 3:
//      utils/schedule.js, utils/classSchedule.js, routes/admin-class-
//      schedule.js) now tolerates an optional ":SS" seconds component -
//      "10:00:00 AM" is exactly what Excel's own default h:mm:ss AM/PM
//      time format produces, not an edge case worth rejecting.
// This file proves both fixes together, end to end, through the real
// HTTP import routes and real .xlsx files built with genuine Excel
// Time-formatted cells (numeric value + number format, not plain
// strings) - the same shape a real co-op's spreadsheet actually has.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const testDbPath = path.join(os.tmpdir(), `schedule-import-time-formats-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-import-time-formats-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

// Builds a real .xlsx buffer where the given cell is a genuine Excel
// numeric time value with a time number format applied - what typing a
// time into an actual spreadsheet produces, never a plain string. `fmt`
// lets a test pick between Excel's h:mm AM/PM (no seconds) and its
// h:mm:ss AM/PM default (with seconds) - both are real formats users hit.
function excelTimeWorkbook(headers, dataRow, timeColIndex, hours, fmt) {
  const ws = XLSX.utils.aoa_to_sheet([headers, dataRow]);
  const cellRef = XLSX.utils.encode_cell({ r: 1, c: timeColIndex });
  ws[cellRef] = { t: 'n', v: hours / 24, z: fmt };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('a Class Schedule import whose Start Time cell is a genuine Excel Time value (not text) still creates the class', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('h:mm AM/PM (no seconds)', async () => {
    const headers = ['Day', 'Hour', 'Class Name', 'Room', 'Grade', 'Class Start Time', 'Class End Time'];
    const buffer = excelTimeWorkbook(headers, ['Wednesday', '1', 'Excel Time No Seconds', 'Room X', '', '', '10:45 AM'], 5, 10, 'h:mm AM/PM');
    const res = await request(app)
      .post(`/admin/class-schedule/wednesday/import?_csrf=${csrfToken}`)
      .set('Cookie', cookie)
      .attach('file', buffer, 'import.xlsx');
    const notice = new URL(res.headers.location, 'http://localhost').searchParams.get('notice');
    assert.match(notice, /Imported 1 class/);
    const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get('Excel Time No Seconds');
    assert.equal(cls.start_time, '10:00 AM');
  });

  await t.test('h:mm:ss AM/PM (with seconds - Excel\'s own default time format)', async () => {
    const headers = ['Day', 'Hour', 'Class Name', 'Room', 'Grade', 'Class Start Time', 'Class End Time'];
    const buffer = excelTimeWorkbook(headers, ['Wednesday', '2', 'Excel Time With Seconds', 'Room Y', '', '', '11:30 AM'], 5, 10.75, 'h:mm:ss AM/PM');
    const res = await request(app)
      .post(`/admin/class-schedule/wednesday/import?_csrf=${csrfToken}`)
      .set('Cookie', cookie)
      .attach('file', buffer, 'import.xlsx');
    const notice = new URL(res.headers.location, 'http://localhost').searchParams.get('notice');
    assert.match(notice, /Imported 1 class/);
    const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get('Excel Time With Seconds');
    assert.equal(cls.start_time, '10:45:00 AM', 'the raw formatted text is stored as-is - what matters is that it still PARSES (see the next test), not that it gets reformatted');
  });
});

test('a Student Schedule import row whose Start Time cell is a genuine Excel Time value still matches its class, instead of being silently skipped', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  // The two classes above (Hour 1: 10:00 AM - 10:45 AM, Hour 2: 10:45:00 AM
  // - 11:30 AM) already exist from the previous test, on the same shared
  // test database - a real co-op's own workflow (Class Schedule import
  // first, Student/Parent Schedule import second, against the classes
  // that import just created).
  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Excel Time Student', 'excel-time-student', 'student')").run()).lastInsertRowid;

  const headers = [
    'Member First Name', 'Member Last Name',
    'Class Start Time 1', 'Class Title 1', 'Class Location 1', 'Class Days 1',
    'Class Start Time 2', 'Class Title 2', 'Class Location 2', 'Class Days 2',
  ];
  const dataRow = ['Excel Time', 'Student', '', 'Excel Time No Seconds', 'Room X', 'Wed', '', 'Excel Time With Seconds', 'Room Y', 'Wed'];
  const ws = XLSX.utils.aoa_to_sheet([headers, dataRow]);
  // Slot 1's Start Time: genuine Excel h:mm AM/PM cell for 10:00 AM.
  ws[XLSX.utils.encode_cell({ r: 1, c: 2 })] = { t: 'n', v: 10 / 24, z: 'h:mm AM/PM' };
  // Slot 2's Start Time: genuine Excel h:mm:ss AM/PM cell for 10:45:00 AM -
  // matching the class's own stored "10:45:00 AM" (with seconds) exactly.
  ws[XLSX.utils.encode_cell({ r: 1, c: 6 })] = { t: 'n', v: 10.75 / 24, z: 'h:mm:ss AM/PM' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const res = await request(app)
    .post(`/admin/schedule/members/import?_csrf=${csrfToken}`)
    .set('Cookie', cookie)
    .field('memberType', 'student')
    .attach('file', buffer, 'import.xlsx');
  const notice = new URL(res.headers.location, 'http://localhost').searchParams.get('notice');
  assert.match(notice, /Matched 2 schedule row/, 'both slots must match - neither should be silently dropped as "no matching class"');
  assert.doesNotMatch(notice, /skipped/);

  const enrolledClassNames = (
    await db.prepare(
      `SELECT c.class_name FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id WHERE ce.student_id = ?`
    ).all(studentId)
  ).map((r) => r.class_name);
  assert.deepEqual(enrolledClassNames.sort(), ['Excel Time No Seconds', 'Excel Time With Seconds']);

  // The actual live-reported symptom: Arrival/Departure must reflect BOTH
  // classes (10:00 AM through 11:30 AM), not just whichever one happened
  // to import cleanly.
  const { arrival, departure } = await arrivalDepartureLabels(studentId, 'wednesday');
  assert.equal(arrival, '10:00 AM');
  assert.equal(departure, '11:30 AM');
});

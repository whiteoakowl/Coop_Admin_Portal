// Real HTTP-level coverage for the Class Check-In kiosk flow (routes/
// kiosk-class-checkin.js) - added alongside the audit's TEST-01 route
// tests since this shares the same "highest-consequence, easy to
// silently regress" profile: the whole point of this feature is that a
// class roster's "present" status comes ONLY from here, never from the
// main portal, and vice versa - a regression in that isolation would be
// completely silent (both paths still return `ok: true`) without a test
// asserting on the actual database rows written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-class-checkin-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-class-checkin-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

// Creates a class meeting today, with one enrolled student already on
// both the class roster and the day's Student roster (mirroring what
// syncClassRosterMembers/syncDayMemberRosters keep in sync for real) -
// setup, not the thing under test. Each call makes its own class/member
// with a unique name+barcode (members.barcode is UNIQUE) so multiple
// sub-tests can call this against the same shared test DB without
// colliding.
let setupCounter = 0;
function setUpClassWithStudent() {
  setupCounter += 1;
  const n = setupCounter;
  const today = todayISO();
  const studentRoster = db.prepare("SELECT id FROM rosters WHERE name = 'Monday Students'").get();
  db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(studentRoster.id, today);

  const classInfo = db
    .prepare("INSERT INTO classes (day, hour_position, class_name, color) VALUES ('monday', 1, ?, '#EE9A4D')")
    .run(`Test Class ${n}`);
  const classId = classInfo.lastInsertRowid;
  const classRosterInfo = db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES (?, 'Class Roster', 'monday')")
    .run(`Test Class ${n}`);
  const classRosterId = classRosterInfo.lastInsertRowid;
  db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(classRosterId, classId);

  const barcode = `Isolation Test Kid ${n}`;
  const memberInfo = db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')")
    .run(barcode, barcode);
  const memberId = memberInfo.lastInsertRowid;
  db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);
  db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(classRosterId, memberId);
  db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(studentRoster.id, memberId);

  return { classId, classRosterId, studentRosterId: studentRoster.id, memberId, barcode, today };
}

test('Class Check-In PIN gate', async (t) => {
  await t.test('the classes list redirects to the PIN page when not unlocked', async () => {
    const res = await request(app).get('/kiosk/class-checkin/classes');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/kiosk/class-checkin');
  });

  await t.test('an incorrect PIN is rejected and does not unlock', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '9999' });
    assert.match(res.text, /Incorrect PIN/);
    const classesRes = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(classesRes.status, 302, 'still locked out after a wrong PIN');
  });

  await t.test('the correct default PIN (0000) unlocks the flow', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/kiosk/class-checkin/classes');
    const classesRes = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(classesRes.status, 200, 'unlocked after the correct PIN');
  });

  await t.test('the Done button locks it again', async () => {
    const agent = request.agent(app);
    await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
    await agent.post('/kiosk/class-checkin/lock');
    const res = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(res.status, 302, 'locked out again after Done');
  });
});

test('Class Check-In scan writes only to the class roster', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('checking in via the class flow marks present on the class roster only', async () => {
    const { classId, classRosterId, studentRosterId, memberId, barcode, today } = setUpClassWithStudent();

    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan`).type('form').send({ barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, barcode);

    const classAttendance = db
      .prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.ok(classAttendance, 'expected a class-roster attendance row');
    assert.equal(classAttendance.status, 'present');
    assert.equal(classAttendance.source, 'kiosk_class_checkin');

    // The critical isolation check: the day's Student roster must NOT
    // have picked up a "present" row from this class-scoped scan.
    const mainAttendance = db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, studentRosterId, today);
    assert.equal(mainAttendance, undefined, 'class check-in must not touch the main day roster');
  });

  await t.test('re-scanning the same student is idempotent, reports "already checked in"', async () => {
    const { classId, barcode } = setUpClassWithStudent();
    await agent.post(`/kiosk/class-checkin/classes/${classId}/scan`).type('form').send({ barcode });
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan`).type('form').send({ barcode });
    assert.equal(res.body.alreadyChecked, true);
  });

  await t.test('a student not enrolled in the class is rejected', async () => {
    const { classId } = setUpClassWithStudent();
    const notEnrolledBarcode = `Not Enrolled Kid ${setupCounter}`;
    db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(notEnrolledBarcode, notEnrolledBarcode);
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan`).type('form').send({ barcode: notEnrolledBarcode });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not enrolled/);
  });
});

test('the main kiosk portal never writes to a class roster', async (t) => {
  await t.test('checking in at the main portal marks the day roster present but leaves the class roster untouched', async () => {
    const { classRosterId, studentRosterId, memberId, barcode, today } = setUpClassWithStudent();

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode });
    assert.equal(res.body.ok, true);

    const mainAttendance = db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, studentRosterId, today);
    assert.equal(mainAttendance.status, 'present');

    const classAttendance = db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.equal(classAttendance, undefined, 'main portal check-in must not touch a class roster');
  });
});

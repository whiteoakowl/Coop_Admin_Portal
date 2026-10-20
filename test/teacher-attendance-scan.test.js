// Coverage for a real request: "Teacher portal. Attendance, click on a
// class to take Attendance, you can click on each block to add
// Attendance manually. There should also be the purple check in and out
// buttons for barcode scanning." The manual click-a-block marking
// already existed (each cell's own colored .roster-cell-select); this
// covers the NEW barcode-scan flow (routes/teacher-portal.js's own GET
// /classes/:id/scan + POST .../scan/checkin|checkout), the same logic
// the Kiosk's own Class Check-In surface uses (see test/routes-kiosk-
// class-checkin.test.js's own setUpClassWithStudent, mirrored here), just
// gated by this teacher's own portal login + class ownership instead of
// the kiosk's shared PIN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-attendance-scan-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-attendance-scan-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let setupCounter = 0;
async function setUpClassWithStudent({ day = 'monday', hourPosition = 1 } = {}) {
  setupCounter += 1;
  const n = setupCounter;
  const today = todayISO();
  const studentRosterName = day === 'monday' ? 'Monday Students' : 'Wednesday Students';
  const studentRoster = await db.prepare('SELECT id FROM rosters WHERE name = ?').get(studentRosterName);
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(studentRoster.id, today);

  const classInfo = await db
    .prepare('INSERT INTO classes (day, hour_position, class_name, color) VALUES (?, ?, ?, ?)')
    .run(day, hourPosition, `Teacher Scan Class ${n}`, '#EE9A4D');
  const classId = classInfo.lastInsertRowid;
  const classRosterInfo = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES (?, 'Class Roster', ?)")
    .run(`Teacher Scan Class ${n}`, day);
  const classRosterId = classRosterInfo.lastInsertRowid;
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(classRosterId, classId);

  const barcode = `Teacher Scan Kid ${n}`;
  const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(barcode, barcode);
  const memberId = memberInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(classRosterId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(studentRoster.id, memberId);

  return { classId, classRosterId, memberId, barcode, day, today };
}

let teacherCounter = 0;
async function loginTeacherFor(classId) {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Scan Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  const email = `scan-teacher-${teacherCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return agent;
}

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

test('the two purple Check In/Check Out buttons render on the attendance page, pointed at this teacher\'s own scan routes', async () => {
  const { classId } = await setUpClassWithStudent();
  const agent = await loginTeacherFor(classId);

  const res = await agent.get(`/teacher/classes/${classId}/attendance`);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="class-checkin-attendance-header"/);
  assert.match(res.text, new RegExp(`<a class="class-checkin-btn" href="/teacher/classes/${classId}/scan\\?mode=checkin">`));
  assert.match(res.text, new RegExp(`<a class="class-checkin-btn" href="/teacher/classes/${classId}/scan\\?mode=checkout">`));
});

test('scanning a barcode checks a student in, writing a present attendance row with a check-in time', async () => {
  const { classId, classRosterId, memberId, barcode, today } = await setUpClassWithStudent();
  const agent = await loginTeacherFor(classId);

  const scanPage = await agent.get(`/teacher/classes/${classId}/scan?mode=checkin`);
  assert.equal(scanPage.status, 200);
  assert.match(scanPage.text, /Check In/);
  const csrf = extractCsrf(scanPage.text);

  // The real scan script sends the token as an X-CSRF-Token header (see
  // public/js/kiosk-class-checkin-scan.js's own comment on why - this
  // view/script is shared with the Kiosk's own unauthenticated scan,
  // which never checks it at all), not a form field.
  const res = await agent.post(`/teacher/classes/${classId}/scan/checkin`).set('X-CSRF-Token', csrf).type('form').send({ barcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.name, barcode);

  const row = await db.prepare('SELECT status, check_in_time FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, classRosterId, today);
  assert.equal(row.status, 'present');
  assert.ok(row.check_in_time);
});

test('scanning a barcode to check out writes a checkouts row', async () => {
  const { classId, classRosterId, memberId, barcode, today } = await setUpClassWithStudent();
  const agent = await loginTeacherFor(classId);
  const csrf = extractCsrf((await agent.get(`/teacher/classes/${classId}/scan?mode=checkout`)).text);

  const res = await agent.post(`/teacher/classes/${classId}/scan/checkout`).set('X-CSRF-Token', csrf).type('form').send({ barcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const row = await db.prepare('SELECT check_out_time FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, classRosterId, today);
  assert.ok(row.check_out_time);
});

test('a teacher cannot scan for a class they do not teach', async () => {
  const { classId: otherClassId } = await setUpClassWithStudent({ day: 'wednesday' });
  const { classId: ownClassId, barcode } = await setUpClassWithStudent();
  const agent = await loginTeacherFor(ownClassId);

  const scanPage = await agent.get(`/teacher/classes/${otherClassId}/scan?mode=checkin`);
  assert.equal(scanPage.status, 403);
  const csrf = extractCsrf((await agent.get(`/teacher/classes/${ownClassId}/scan?mode=checkin`)).text);

  const res = await agent.post(`/teacher/classes/${otherClassId}/scan/checkin`).set('X-CSRF-Token', csrf).type('form').send({ barcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /not found/i);
});

test('a student not enrolled in the class cannot be checked in', async () => {
  const { classId } = await setUpClassWithStudent();
  const agent = await loginTeacherFor(classId);
  const notEnrolledBarcode = 'Teacher Scan Not Enrolled';
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(notEnrolledBarcode, notEnrolledBarcode);
  const csrf = extractCsrf((await agent.get(`/teacher/classes/${classId}/scan?mode=checkin`)).text);

  const res = await agent.post(`/teacher/classes/${classId}/scan/checkin`).set('X-CSRF-Token', csrf).type('form').send({ barcode: notEnrolledBarcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /not enrolled/i);
});

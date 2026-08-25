// Real HTTP-level coverage for the Class Check-In kiosk flow (routes/
// kiosk-class-checkin.js) - added alongside the audit's TEST-01 route
// tests since this shares the same "highest-consequence, easy to
// silently regress" profile: the whole point of this feature is that a
// class roster's "present"/checkout status comes ONLY from here, never
// from the main portal, and vice versa - a regression in that isolation
// would be completely silent (both paths still return `ok: true`)
// without a test asserting on the actual database rows written.
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
const { addStaff, removeStaff } = require('../utils/classSchedule');

test.before(() => app.ready);
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
// colliding. `day`/`hourPosition` are overridable for the day-picker and
// hour-filter tests below.
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
    .run(day, hourPosition, `Test Class ${n}`, '#EE9A4D');
  const classId = classInfo.lastInsertRowid;
  const classRosterInfo = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES (?, 'Class Roster', ?)")
    .run(`Test Class ${n}`, day);
  const classRosterId = classRosterInfo.lastInsertRowid;
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(classRosterId, classId);

  const barcode = `Isolation Test Kid ${n}`;
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')")
    .run(barcode, barcode);
  const memberId = memberInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(classRosterId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(studentRoster.id, memberId);

  return { classId, classRosterId, studentRosterId: studentRoster.id, memberId, barcode, day, today };
}

test('Class Check-In PIN gate', async (t) => {
  await t.test('the day picker redirects to the PIN page when not unlocked', async () => {
    const res = await request(app).get('/kiosk/class-checkin/classes');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/kiosk/class-checkin?next=%2Fkiosk%2Fclass-checkin%2Fclasses');
  });

  await t.test('an incorrect PIN is rejected and does not unlock', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '9999' });
    assert.match(res.text, /Incorrect PIN/);
    const classesRes = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(classesRes.status, 302, 'still locked out after a wrong PIN');
  });

  await t.test('the correct default PIN (0000) unlocks the flow, showing the day picker', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/kiosk/class-checkin/classes');
    const classesRes = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(classesRes.status, 200, 'unlocked after the correct PIN');
    assert.match(classesRes.text, /Monday/);
    assert.match(classesRes.text, /Wednesday/);
  });

  await t.test('the Done button locks it again', async () => {
    const agent = request.agent(app);
    await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
    await agent.post('/kiosk/class-checkin/lock');
    const res = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(res.status, 302, 'locked out again after Done');
  });
});

// A real request: every class gets its own "quick link" straight to its
// attendance sheet (views/partials/class-schedule-grid.ejs), but this
// whole surface is PIN-gated - hitting that link locked has to land back
// on the SAME class after the PIN, not just the day picker a generic
// unlock would otherwise always send you to.
test('Class Check-In quick link (?next=) round-trip through the PIN gate', async (t) => {
  const { classId } = await setUpClassWithStudent();
  const targetPath = `/kiosk/class-checkin/classes/${classId}/attendance`;

  await t.test('hitting a class quick link while locked redirects to the PIN page with ?next set to it', async () => {
    const res = await request(app).get(targetPath);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/kiosk/class-checkin?next=${encodeURIComponent(targetPath)}`);
  });

  await t.test('the PIN page carries that class along as a hidden field', async () => {
    const res = await request(app).get(`/kiosk/class-checkin?next=${encodeURIComponent(targetPath)}`);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`name="next" value="${targetPath.replace(/\//g, '\\/')}"`));
  });

  await t.test('the correct PIN redirects straight to that class\'s attendance page, not the day picker', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000', next: targetPath });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, targetPath);
    const attendanceRes = await agent.get(targetPath);
    assert.equal(attendanceRes.status, 200, 'already unlocked, the class page itself now loads');
  });

  await t.test('a wrong PIN re-renders with the same next still carried, so a second correct attempt still lands there', async () => {
    const agent = request.agent(app);
    const wrongRes = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '9999', next: targetPath });
    assert.match(wrongRes.text, new RegExp(`name="next" value="${targetPath.replace(/\//g, '\\/')}"`));

    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000', next: targetPath });
    assert.equal(res.headers.location, targetPath);
  });

  await t.test('an absolute/external next is ignored, not honored as an open redirect', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000', next: 'https://evil.example/phish' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/kiosk/class-checkin/classes', 'falls back to the normal day picker instead of an external URL');
  });

  await t.test('already unlocked, visiting the PIN page with ?next redirects straight there too', async () => {
    const agent = request.agent(app);
    await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
    const res = await agent.get(`/kiosk/class-checkin?next=${encodeURIComponent(targetPath)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, targetPath);
  });
});

test('Class Check-In day and hour navigation', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('an invalid day 404s', async () => {
    const res = await agent.get('/kiosk/class-checkin/classes/tuesday');
    assert.equal(res.status, 404);
  });

  await t.test("a day's class list only shows that day's classes", async () => {
    const monday = await setUpClassWithStudent({ day: 'monday', hourPosition: 1 });
    const wednesday = await setUpClassWithStudent({ day: 'wednesday', hourPosition: 1 });

    const mondayRes = await agent.get('/kiosk/class-checkin/classes/monday');
    assert.match(mondayRes.text, new RegExp(`href="/kiosk/class-checkin/classes/${monday.classId}/attendance"`));
    assert.doesNotMatch(mondayRes.text, new RegExp(`href="/kiosk/class-checkin/classes/${wednesday.classId}/attendance"`));

    const wednesdayRes = await agent.get('/kiosk/class-checkin/classes/wednesday');
    assert.match(wednesdayRes.text, new RegExp(`href="/kiosk/class-checkin/classes/${wednesday.classId}/attendance"`));
    assert.doesNotMatch(wednesdayRes.text, new RegExp(`href="/kiosk/class-checkin/classes/${monday.classId}/attendance"`));
  });

  await t.test('the Hour filter narrows the list to just that hour', async () => {
    const hourOne = await setUpClassWithStudent({ day: 'monday', hourPosition: 1 });
    const hourTwo = await setUpClassWithStudent({ day: 'monday', hourPosition: 2 });

    const filtered = await agent.get('/kiosk/class-checkin/classes/monday?hour=2');
    assert.match(filtered.text, new RegExp(`href="/kiosk/class-checkin/classes/${hourTwo.classId}/attendance"`));
    assert.doesNotMatch(filtered.text, new RegExp(`href="/kiosk/class-checkin/classes/${hourOne.classId}/attendance"`));
  });

  await t.test('picking a class goes straight to its attendance sheet, with purple Check In/Check Out buttons', async () => {
    const { classId } = await setUpClassWithStudent();
    const res = await agent.get(`/kiosk/class-checkin/classes/${classId}/attendance`);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`href="/kiosk/class-checkin/classes/${classId}/scan\\?mode=checkin"`));
    assert.match(res.text, new RegExp(`href="/kiosk/class-checkin/classes/${classId}/scan\\?mode=checkout"`));
    assert.match(res.text, /class-checkin-btn/);
    // A real bug report: the roster's header/legend/table sat directly on
    // the kiosk's blue page background, each looking like its own
    // disconnected white box - wrapping them all in one .form-outer-panel
    // (the site's existing "unify boxes on a public page" pattern) fixes
    // it. class="form-wrap form-wrap-roster" (wider than the default
    // public-form column - a 4-column table needs the room) confirms the
    // page opted into the wider panel too.
    assert.match(res.text, /class="form-wrap form-wrap-roster"/);
    assert.match(res.text, /<div class="form-outer-panel">/);
  });

  await t.test('an unknown class id 404s on attendance and on scan', async () => {
    const attendanceRes = await agent.get('/kiosk/class-checkin/classes/999999/attendance');
    assert.equal(attendanceRes.status, 404);
    const scanRes = await agent.get('/kiosk/class-checkin/classes/999999/scan');
    assert.equal(scanRes.status, 404);
  });
});

// A real request: "class attendance should allow for manually changing
// P, L, A just like the Monday/Wednesday attendance. it should then save
// automatically." Covers the same POST /classes/:id/attendance route
// admin-rosters.js's own attendance test suite covers for the day
// rosters - same status:<memberId>:<date> body-key convention, same
// upsert-or-clear/source='manual' write, just PIN-gated instead of
// requiring a logged-in admin.
test('Class Check-In manual P/L/A editing on the attendance sheet', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('the attendance sheet renders an editable P/L/A select for each student, pointed at this class\'s own endpoint', async () => {
    const { classId, memberId } = await setUpClassWithStudent();
    const res = await agent.get(`/kiosk/class-checkin/classes/${classId}/attendance`);
    assert.equal(res.status, 200);
    assert.match(
      res.text,
      new RegExp(`<select class="roster-cell-select roster-cell-select-blank" data-endpoint="/kiosk/class-checkin/classes/${classId}/attendance" data-member="${memberId}"`)
    );
  });

  await t.test('marking a student present via the select writes a manual attendance row on the class roster and reflects back on reload', async () => {
    const { classId, classRosterId, memberId, today } = await setUpClassWithStudent();

    const res = await agent
      .post(`/kiosk/class-checkin/classes/${classId}/attendance`)
      .type('form')
      .send({ [`status:${memberId}:${today}`]: 'present' });
    assert.equal(res.status, 302, 'a plain form POST (no X-Requested-With) redirects back to the attendance page');

    const row = await db.prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, classRosterId, today);
    assert.equal(row.status, 'present');
    assert.equal(row.source, 'manual', 'distinguishable from a real kiosk scan');

    const reload = await agent.get(`/kiosk/class-checkin/classes/${classId}/attendance`);
    assert.match(reload.text, new RegExp(`data-member="${memberId}"[^>]*data-date="${today}" data-original="present"`));
  });

  await t.test('the fetch()-based auto-save path (X-Requested-With) returns JSON instead of redirecting', async () => {
    const { classId, memberId, today } = await setUpClassWithStudent();
    const res = await agent
      .post(`/kiosk/class-checkin/classes/${classId}/attendance`)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ [`status:${memberId}:${today}`]: 'late' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  await t.test('clearing the select (blank option) removes the attendance row entirely, not just marks it blank', async () => {
    const { classId, classRosterId, memberId, today } = await setUpClassWithStudent();
    await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')").run(memberId, classRosterId, today);

    await agent
      .post(`/kiosk/class-checkin/classes/${classId}/attendance`)
      .type('form')
      .send({ [`status:${memberId}:${today}`]: '' });

    const row = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, classRosterId, today);
    assert.equal(row, undefined);
  });

  await t.test('manually editing one class does not touch the day-level Student roster or a different class', async () => {
    const { classId, memberId, studentRosterId, today } = await setUpClassWithStudent();
    const other = await setUpClassWithStudent();

    await agent
      .post(`/kiosk/class-checkin/classes/${classId}/attendance`)
      .type('form')
      .send({ [`status:${memberId}:${today}`]: 'present' });

    const dayRosterRow = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, studentRosterId, today);
    assert.equal(dayRosterRow, undefined, 'writing to the class roster must not also write to the day Student roster');
    const otherClassRow = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ?').get(other.memberId, other.classRosterId);
    assert.equal(otherClassRow, undefined, 'a different class\'s roster is untouched');
  });

  await t.test('an unknown class id 404s on the POST too', async () => {
    const res = await agent.post('/kiosk/class-checkin/classes/999999/attendance').type('form').send({ 'status:1:2026-01-01': 'present' });
    assert.equal(res.status, 404);
  });
});

// A real request: "teachers and assistants should be able to be checked
// in on the class roster." Before this, a class's own roster
// (syncClassRosterMembers, utils/classSchedule.js) only ever held its
// enrolled students - its teacher(s)/assistant(s) (class_staff) were
// only ever added to the day-level Parent (or Student, for a teen
// staffer - see classSchedule-student-staff.test.js) roster, never this
// specific class's own roster/attendance sheet, so they had no way to be
// checked in/out FOR that class specifically.
test('teachers and assistants can be checked in/out on their own class\'s roster', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('a teacher appears on the class attendance sheet and can be checked in via scan', async () => {
    const { classId, classRosterId, today } = await setUpClassWithStudent();
    const teacherId = (
      await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class Roster Teacher', 'class-roster-teacher-1', 'parent')").run()
    ).lastInsertRowid;
    await addStaff(classId, teacherId, 'teacher');

    const attendanceRes = await agent.get(`/kiosk/class-checkin/classes/${classId}/attendance`);
    assert.equal(attendanceRes.status, 200);
    assert.match(attendanceRes.text, /Class Roster Teacher/, "the teacher should show up on this class's own attendance sheet");

    const scanRes = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode: 'class-roster-teacher-1' });
    assert.equal(scanRes.body.ok, true);
    assert.match(scanRes.body.message, /Welcome, Class Roster Teacher!/);

    const row = await db
      .prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(teacherId, classRosterId, today);
    assert.equal(row.status, 'present');
    assert.equal(row.source, 'kiosk_class_checkin');
  });

  await t.test('an assistant can be checked out the same way, and removing them drops them off the roster again', async () => {
    const { classId, classRosterId, today } = await setUpClassWithStudent();
    const assistantId = (
      await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class Roster Assistant', 'class-roster-assistant-1', 'parent')").run()
    ).lastInsertRowid;
    await addStaff(classId, assistantId, 'assistant');

    const checkoutRes = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode: 'class-roster-assistant-1' });
    assert.equal(checkoutRes.body.ok, true);
    const checkoutRow = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(assistantId, classRosterId, today);
    assert.ok(checkoutRow, 'expected a checkout row scoped to the class roster');

    await removeStaff(classId, assistantId);
    const stillOnRoster = await db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(classRosterId, assistantId);
    assert.equal(stillOnRoster, undefined, 'removing a staff member from the class should also drop them off its roster');
  });

  await t.test("a teacher staffing one class does not show up on (or scan into) an unrelated class's roster", async () => {
    const { classId: classA, classRosterId: rosterA } = await setUpClassWithStudent();
    const { classId: classB } = await setUpClassWithStudent();
    const teacherId = (
      await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class A Only Teacher', 'class-a-only-teacher-1', 'parent')").run()
    ).lastInsertRowid;
    await addStaff(classA, teacherId, 'teacher');

    const onA = await db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(rosterA, teacherId);
    assert.ok(onA, "the teacher should be on their own class's roster");

    const scanOnB = await agent.post(`/kiosk/class-checkin/classes/${classB}/scan/checkin`).type('form').send({ barcode: 'class-a-only-teacher-1' });
    assert.equal(scanOnB.body.ok, false, 'a teacher staffing a different class must not be checkable in on this one');
  });
});

test('Class Check-In check-in writes only to the class roster', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('checking in via the class flow marks present on the class roster only', async () => {
    const { classId, classRosterId, studentRosterId, memberId, barcode, today } = await setUpClassWithStudent();

    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, barcode);

    const classAttendance = await db
      .prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.ok(classAttendance, 'expected a class-roster attendance row');
    assert.equal(classAttendance.status, 'present');
    assert.equal(classAttendance.source, 'kiosk_class_checkin');

    // The critical isolation check: the day's Student roster must NOT
    // have picked up a "present" row from this class-scoped scan.
    const mainAttendance = await db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, studentRosterId, today);
    assert.equal(mainAttendance, undefined, 'class check-in must not touch the main day roster');
  });

  await t.test('re-scanning the same student to check in is idempotent, reports "already checked in"', async () => {
    const { classId, barcode } = await setUpClassWithStudent();
    await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode });
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode });
    assert.equal(res.body.alreadyChecked, true);
  });

  await t.test('a student not enrolled in the class is rejected', async () => {
    const { classId } = await setUpClassWithStudent();
    const notEnrolledBarcode = `Not Enrolled Kid ${setupCounter}`;
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(notEnrolledBarcode, notEnrolledBarcode);
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode: notEnrolledBarcode });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not enrolled/);
  });

  await t.test('checking in by typing the member\'s exact name (no barcode) works too', async () => {
    const { classId, memberId, classRosterId, today } = await setUpClassWithStudent();
    const name = `Isolation Test Kid ${setupCounter}`;
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode: name });
    assert.equal(res.body.ok, true);
    const classAttendance = await db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.equal(classAttendance.status, 'present');
  });

  await t.test('checking in overrides a prior absent/late status on the class roster', async () => {
    const { classId, classRosterId, memberId, barcode, today } = await setUpClassWithStudent();
    await db.prepare(
      "INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')"
    ).run(memberId, classRosterId, today);

    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyChecked, undefined, 'an absent status should not be treated as already-checked-in');

    const classAttendance = await db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.equal(classAttendance.status, 'present', 'checking in must override a prior absent status');
  });
});

test('Class Check-In check-out writes only to the class roster, with no pickup number', async (t) => {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('checking out records a checkouts row scoped to the class roster with number = NULL', async () => {
    const { classId, classRosterId, studentRosterId, memberId, barcode, today } = await setUpClassWithStudent();

    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, barcode);

    const classCheckout = await db
      .prepare('SELECT number, check_out_time FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.ok(classCheckout, 'expected a class-roster checkout row');
    assert.equal(classCheckout.number, null, 'class checkout must not require/record a pickup number');
    assert.ok(classCheckout.check_out_time > 0);

    const mainCheckout = await db
      .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, studentRosterId, today);
    assert.equal(mainCheckout, undefined, 'class check-out must not touch the main day roster');
  });

  await t.test('checking out does not require a prior check-in', async () => {
    const { classId, barcode } = await setUpClassWithStudent();
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyChecked, undefined);
  });

  await t.test('re-scanning the same student to check out is idempotent, reports "already checked out"', async () => {
    const { classId, barcode } = await setUpClassWithStudent();
    await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode });
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode });
    assert.equal(res.body.alreadyChecked, true);
  });

  await t.test('checking out by typing the member\'s exact name (no barcode) works too', async () => {
    const { classId, memberId, classRosterId, today } = await setUpClassWithStudent();
    const name = `Isolation Test Kid ${setupCounter}`;
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode: name });
    assert.equal(res.body.ok, true);
    const classCheckout = await db
      .prepare('SELECT number FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.equal(classCheckout.number, null);
  });

  await t.test('an ambiguous name (two active members sharing it) is rejected with a specific message', async () => {
    const { classId } = await setUpClassWithStudent();
    const dupName = `Duplicate Class Checkin Kid ${setupCounter}`;
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(dupName, `dup-a-${setupCounter}`);
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(dupName, `dup-b-${setupCounter}`);
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkout`).type('form').send({ barcode: dupName });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /more than one member/i);
  });
});

test('the main kiosk portal never writes to a class roster', async (t) => {
  await t.test('checking in at the main portal marks the day roster present but leaves the class roster untouched', async () => {
    const { classRosterId, studentRosterId, memberId, barcode, today } = await setUpClassWithStudent();

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode });
    assert.equal(res.body.ok, true);

    const mainAttendance = await db
      .prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, studentRosterId, today);
    assert.equal(mainAttendance.status, 'present');

    const classAttendance = await db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, classRosterId, today);
    assert.equal(classAttendance, undefined, 'main portal check-in must not touch a class roster');
  });
});

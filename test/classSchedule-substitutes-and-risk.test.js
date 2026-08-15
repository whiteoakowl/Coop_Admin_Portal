// Coverage for two bug fixes to utils/classSchedule.js's Attendance-page
// alert helpers:
//
// - classesNeedingStaffForDay(day, date) used to flag any class missing a
//   teacher and/or assistant BY DESIGN (never assigned one at all), which
//   meant a class that simply doesn't need an assistant showed up as
//   "needs a substitute" every single day. It should only flag a class
//   whose ASSIGNED teacher/assistant is absent or late on `date`.
//
// - classesAtRiskForDay(day, date) used to count anyone with attendance
//   status='absent' from ANY source (including a plain kiosk no-show
//   mark). It should only count students with a submitted Absence form
//   (source='absence_form', status='absent') - a "late" form doesn't
//   count either, since that student is still coming.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classschedule-sub-risk-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classschedule-sub-risk-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const {
  createClass,
  addStaff,
  setEnrollment,
  classesNeedingStaffForDay,
  classesAtRiskForDay,
  absenceFormAbsentMemberIdsForDate,
} = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function makeMember(name, barcode, memberType) {
  return (await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(name, barcode, memberType)).lastInsertRowid;
}

test('classesNeedingStaffForDay only flags an ASSIGNED teacher/assistant who is absent or late today', async (t) => {
  const teacherId = await makeMember('Sub Needed Teacher', 'sub-needed-teacher', 'parent');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Sub Needed Class' });
  await addStaff(classId, teacherId, 'teacher');
  // Deliberately no assistant assigned - that's a staffing-plan choice,
  // not something a substitute needs to cover.

  await t.test('a class with no absence data for the date is never flagged, even without an assistant', async () => {
    const result = await classesNeedingStaffForDay('monday', '2026-02-02');
    assert.equal(result.find((c) => c.className === 'Sub Needed Class'), undefined);
  });

  await t.test('a class with no date at all is never flagged', async () => {
    const result = await classesNeedingStaffForDay('monday', null);
    assert.equal(result.find((c) => c.className === 'Sub Needed Class'), undefined);
  });

  await t.test('the class IS flagged once its assigned teacher is marked absent that date', async () => {
    const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Sub Needed Roster', 'Class Schedule')").run()).lastInsertRowid;
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-02', 'absent', 'kiosk')")
      .run(teacherId, rosterId);

    const result = await classesNeedingStaffForDay('monday', '2026-02-02');
    const flagged = result.find((c) => c.className === 'Sub Needed Class');
    assert.ok(flagged, 'expected the class to be flagged once its assigned teacher is absent');
    assert.equal(flagged.missingTeacher, true);
    assert.equal(flagged.missingAssistant, false, 'no assistant was ever assigned, so there is nothing to flag as missing');
  });
});

test('classesAtRiskForDay only counts students with a submitted Absence form, not any "absent" status', async (t) => {
  const day = 'wednesday';
  const classId = await createClass({ day, hourPosition: 2, className: 'Risk Test Class' });
  const students = [];
  for (let i = 1; i <= 4; i++) students.push(await makeMember(`Risk Kid ${i}`, `risk-kid-${i}`, 'student'));
  await setEnrollment(classId, students);
  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Risk Test Roster', 'Class Schedule')").run()).lastInsertRowid;

  await t.test('a kiosk-marked absence (no form) is not counted by the risk-scoped absence helper', async () => {
    // Under the old bug (any status='absent' regardless of source) this
    // would count toward risk; the fix requires only a submitted Absence
    // form to count.
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-04', 'absent', 'kiosk')")
      .run(students[0], rosterId);

    const ids = await absenceFormAbsentMemberIdsForDate('2026-02-04');
    assert.ok(!ids.has(students[0]), 'a kiosk-only absence (no form) must not count as an absence-form absence');

    const result = await classesAtRiskForDay(day, '2026-02-04');
    assert.equal(result.find((c) => c.className === 'Risk Test Class'), undefined, 'expected count is still 4/4, so risk should not trigger');
  });

  await t.test('a "late" form does not reduce the expected count (still coming)', async () => {
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-04', 'late', 'absence_form')")
      .run(students[1], rosterId);

    const ids = await absenceFormAbsentMemberIdsForDate('2026-02-04');
    assert.ok(!ids.has(students[1]), 'a late form must not count as absent for cancellation-risk purposes');

    const result = await classesAtRiskForDay(day, '2026-02-04');
    assert.equal(result.find((c) => c.className === 'Risk Test Class'), undefined, 'expected count is still 4/4, so risk should not trigger');
  });

  await t.test('an Absence form submission DOES reduce the expected count and can trigger risk', async () => {
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-04', 'absent', 'absence_form')")
      .run(students[2], rosterId);
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-04', 'absent', 'absence_form')")
      .run(students[3], rosterId);

    const result = await classesAtRiskForDay(day, '2026-02-04');
    const flagged = result.find((c) => c.className === 'Risk Test Class');
    assert.ok(flagged, 'two absence-form submissions should bring expected down to 2 and trigger risk');
    assert.equal(flagged.expectedCount, 2);
    assert.equal(flagged.enrolledCount, 4);
  });
});

test('classesAtRiskForDay does not flag a naturally small class with zero absences', async (t) => {
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 3, className: 'Naturally Small Class' });
  const students = [];
  for (let i = 1; i <= 3; i++) students.push(await makeMember(`Small Class Kid ${i}`, `small-class-kid-${i}`, 'student'));
  await setEnrollment(classId, students);

  await t.test('3 enrolled, 0 absences: not at risk - it is just a small class', async () => {
    const result = await classesAtRiskForDay(day, '2026-02-09');
    assert.equal(result.find((c) => c.className === 'Naturally Small Class'), undefined);
  });

  await t.test('once one of the 3 submits an Absence form, it IS at risk', async () => {
    const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Small Class Roster', 'Class Schedule')").run()).lastInsertRowid;
    await db
      .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-02-09', 'absent', 'absence_form')")
      .run(students[0], rosterId);

    const result = await classesAtRiskForDay(day, '2026-02-09');
    const flagged = result.find((c) => c.className === 'Naturally Small Class');
    assert.ok(flagged, 'a real absence-form submission on an already-small class should still trigger risk');
    assert.equal(flagged.expectedCount, 2);
  });
});

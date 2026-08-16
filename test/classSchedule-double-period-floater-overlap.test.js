// Coverage for a live bug report, traced from a real member's Schedule
// Card: a student enrolled in a genuine "double period" class - one whose
// own explicit end_time runs into what would normally be the NEXT hour
// position (e.g. filed under position 1, but its own end_time is
// position 2's own end_time) - stayed on the Floater Assignments list for
// that next position even after being enrolled, and her Schedule Card
// kept showing a "Floater" row for it. Root cause: removeFromFloaterForHour
// (fired by addStaff, and now also by setEnrollment - it never fired for
// students at all before this fix) only ever cleared the class's own
// literal hour_position, with no way to know the class's real time also
// reaches into another position it isn't filed under. Fixed with
// positionsOverlappingRange/floaterPositionsCoveredByClass - every
// position a class's own effective time genuinely overlaps, not just the
// one it's filed under - and the same overlap check in
// liveMemberScheduleRowsForDay so an ALREADY-existing bad floater
// assignment (from before this fix shipped) stops rendering as a
// "Floater" row too, without requiring a separate admin cleanup step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `double-period-floater-overlap-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `double-period-floater-overlap-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff, liveMemberScheduleRowsForDay } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection, membersForSection } = require('../utils/volunteers');

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

test('a student enrolled in a double-period class is cleared off (and stops rendering as) a Floater section the class overlaps but isn\'t filed under', async (t) => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({
      labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'],
      startTimes: ['10:00 AM', '10:45 AM', '', ''],
      endTimes: ['10:45 AM', '11:30 AM', '', ''],
      _csrf: csrfToken,
    });

  // "Baking & Culinary Arts" - filed under Hour 1, but its own end_time
  // (11:30 AM) runs into Hour 2's own 10:45-11:30 slot too.
  const classId = await createClass({
    day: 'monday', hourPosition: 1, className: 'Baking & Culinary Arts', room: 'Kitchen', startTime: '10:00 AM', endTime: '11:30 AM',
  });
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Destiny Thomas', 'destiny-thomas', 'student')").run()
  ).lastInsertRowid;

  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  const hour2 = sections.find((s) => s.position === 2);
  // Manually on Hour 2's floater section BEFORE enrollment - simulating
  // the exact live-bug-report scenario (however she originally got added).
  await addMemberToSection(list.id, studentId, hour2.id);

  await setEnrollment(classId, [studentId]);

  await t.test('enrollment clears her off Hour 2\'s floater section (the class\'s own real time overlaps it), not just Hour 1', async () => {
    assert.ok(!(await membersForSection(list.id, hour2.id)).some((m) => m.id === studentId));
  });

  await t.test('her live Schedule Card row for Hour 2 no longer shows a "Floater" row at all', async () => {
    const rows = await liveMemberScheduleRowsForDay('monday');
    assert.equal(rows[studentId][2], undefined, 'Hour 2 should be entirely absent now, not a stray Floater row');
    assert.equal(rows[studentId][1].class_name, 'Baking & Culinary Arts');
    assert.equal(rows[studentId][1].time, '10:00 AM - 11:30 AM');
  });

  await t.test('re-adding her to Hour 2\'s floater section directly (bypassing setEnrollment) is still suppressed in the live display, so already-bad existing data self-heals without an admin cleanup step', async () => {
    await addMemberToSection(list.id, studentId, hour2.id);
    const rows = await liveMemberScheduleRowsForDay('monday');
    assert.equal(rows[studentId][2], undefined, 'the display itself must not trust stale/bad floater membership either');
  });
});

test('addStaff (teacher/assistant) gets the identical overlap-aware floater clearing as setEnrollment', async () => {
  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/wednesday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({
      labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'],
      startTimes: ['', '', '12:00 PM', '12:45 PM'],
      endTimes: ['', '', '12:45 PM', '1:30 PM'],
      _csrf: csrfToken,
    });

  const classId = await createClass({
    day: 'wednesday', hourPosition: 3, className: 'Nature Explorers', startTime: '12:00 PM', endTime: '1:30 PM',
  });
  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Long Class Teacher', 'long-class-teacher', 'parent')").run()
  ).lastInsertRowid;

  const list = await getListByDay('wednesday');
  const sections = await sectionsForList(list.id);
  const hour4 = sections.find((s) => s.position === 4);
  await addMemberToSection(list.id, teacherId, hour4.id);

  await addStaff(classId, teacherId, 'teacher');

  assert.ok(!(await membersForSection(list.id, hour4.id)).some((m) => m.id === teacherId), 'Hour 4 (overlapped by the class\'s own 12:00-1:30 span) should be cleared too');
});

// Coverage for a live follow-up question: does Arrival/Departure
// self-heal the same way the Schedule Card now does (see
// classSchedule-double-period-floater-overlap.test.js) for a member who
// was ALREADY on an overlapping floater section before that fix shipped?
// addStaff/setEnrollment now clear a class's overlapping floater
// positions going forward, but that only fires when something re-touches
// THAT specific class's enrollment/staffing - a member's existing bad
// floater membership from before the fix landed would otherwise sit
// there untouched, still getting unioned into their Arrival/Departure
// window by familyAttendanceWindowsForDay. Fixed by giving that function
// the same overlap check liveMemberScheduleRowsForDay already has: a
// floater section whose own hour range overlaps ANY of the member's real
// class ranges is skipped, regardless of how or when they ended up on
// that floater section.
//
// Uses a PARTIAL overlap on purpose (the class's own real end_time,
// 11:00 AM, is short of Hour 2's own 11:30 AM end) specifically so a
// wrong, inflated Departure (11:30, from the floater) is distinguishable
// from the correct one (11:00, from the real class) - the two aren't the
// same number, unlike the original live bug report's own class, which
// happened to run exactly through Hour 2's own end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `arrival-departure-overlap-selfheal-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `arrival-departure-overlap-selfheal-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');
const { arrivalDepartureLabelsForMembers } = require('../utils/schedule');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');

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

test('a stale floater membership left over on a position a real class partially overlaps no longer inflates Departure', async () => {
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

  // Filed under Hour 1, but its own end_time (11:00 AM) only partially
  // reaches into Hour 2's own 10:45-11:30 slot - short of Hour 2's own
  // end.
  const classId = await createClass({
    day: 'monday', hourPosition: 1, className: 'Partial Overlap Class', startTime: '10:00 AM', endTime: '11:00 AM',
  });
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Partial Overlap Kid', 'partial-overlap-kid', 'student')").run()
  ).lastInsertRowid;

  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  const hour2 = sections.find((s) => s.position === 2);

  await setEnrollment(classId, [studentId]);
  // Simulating a floater membership that predates this fix - added
  // directly, bypassing setEnrollment's own overlap clearing, the same
  // way an already-live production row would have gotten there before
  // this fix ever shipped.
  await addMemberToSection(list.id, studentId, hour2.id);

  const labels = await arrivalDepartureLabelsForMembers([studentId], 'monday');
  assert.deepEqual(
    labels[studentId],
    { arrival: '10:00 AM', departure: '11:00 AM' },
    'Departure must reflect the real class\'s own 11:00 AM end, not the stale floater section\'s later 11:30 AM'
  );
});

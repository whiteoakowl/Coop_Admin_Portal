// Coverage for a live bug report: Arrival/Departure was still showing the
// same 10:00 AM - 11:30 AM for many members after the "one longer class
// contaminates a shared position" fix (see
// classSchedule-longer-class-contamination.test.js) had already landed.
// Root cause: that fix only protected a member's own REAL class enrollment/
// staffing (effectiveClassRange always prefers the class's own start/end,
// falling back to the hour's own start/end - never another class sharing
// the position). Floater assignments went through a different path -
// familyAttendanceWindowsForDay was still using positionRanges
// (derivedHourTimeRanges), which - for any hour position with no
// hour-level Start/End Time saved - falls back to "whichever class at that
// position has the earliest start_time wins, use THAT class's own
// end_time" as a best-effort DISPLAY label. That per-class guess is a
// reasonable label, but it was also being used as if it were a real
// attendance time for anyone floated onto that hour who has no class of
// their own there at all - so a parent floated onto an hour position that
// happens to contain one particular 10:00-11:30 class, with no hour-level
// time of its own set, silently inherited that one class's own duration.
// Fixed by adding hourOnlyRange - floater sections now only ever
// contribute a range when the hour ITSELF has a real saved start/end time;
// a floater on an hour with no hour-level time correctly gets no
// contribution from that hour, rather than a guessed one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `floater-window-no-guess-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `floater-window-no-guess-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
const { arrivalDepartureLabelsForMembers } = require('../utils/schedule');

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

test('a parent floated onto an hour with no hour-level time does not inherit one class\'s own duration', async () => {
  const { cookie } = await loginAsAdmin();
  // Hour 1 has a real hour-level time; Hour 2 deliberately does not - only
  // one specific class at Hour 2 has its own explicit (long) start/end.
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({
      labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'],
      startTimes: ['9:00 AM', '', '', ''],
      endTimes: ['9:45 AM', '', '', ''],
      _csrf: csrfToken,
    });

  const classId = await createClass({
    day: 'monday',
    hourPosition: 2,
    className: 'Long Class',
    room: 'Fellowship Hall',
    startTime: '10:00 AM',
    endTime: '11:30 AM',
  });
  const teacherId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Amanda Jones', 'amanda-jones', 'parent')").run())
    .lastInsertRowid;
  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Eli Thomas', 'eli-thomas', 'student')").run())
    .lastInsertRowid;
  await addStaff(classId, teacherId, 'teacher');
  await setEnrollment(classId, [studentId]);

  // A parent with no class of their own at Hour 2 at all, floated there
  // directly (simulating a leftover from the earlier over-floater-
  // assignment bug, or simply an admin manually adding them).
  const floaterParentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Floater Parent', 'floater-parent', 'parent')").run()
  ).lastInsertRowid;
  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  await addMemberToSection(list.id, floaterParentId, sections.find((s) => s.position === 2).id);

  const labels = await arrivalDepartureLabelsForMembers([teacherId, studentId, floaterParentId], 'monday');

  assert.deepEqual(
    labels[teacherId],
    { arrival: '10:00 AM', departure: '11:30 AM' },
    'the teacher actually assigned to the long class should still correctly show its real time'
  );
  assert.deepEqual(
    labels[studentId],
    { arrival: '10:00 AM', departure: '11:30 AM' },
    'the student actually enrolled in the long class should still correctly show its real time'
  );
  assert.deepEqual(
    labels[floaterParentId],
    { arrival: null, departure: null },
    'a parent only floated onto the hour (no class of their own, no hour-level time set) must not inherit the long class\'s own duration'
  );
});

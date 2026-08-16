// Coverage for a live bug report: every family's Monday/Wednesday roster
// showed the exact same Arrival/Departure (whatever Hour 1's own class time
// happened to be), no matter which hours a family's own students/staff
// were actually enrolled in. Root cause was in derivedHourTimeRanges
// (utils/classSchedule.js): a class with only a Start Time filled in (no
// End Time - which turned out to be the co-op's actual data state, not a
// parsing bug) got a fabricated zero-length range whose "end" defaulted to
// equal its own start. familyAttendanceWindowsForDay then treated that
// fabricated end as if it were a real departure time, so any family whose
// only classes had unset end times ended up with a Departure equal to
// some class's Start Time instead of an honest blank - and coincidentally
// identical across many different families whenever their schedules
// happened to share a start time. Fixed by leaving endMin null instead of
// defaulting it (see derivedHourTimeRanges and extendWindow's own
// comments) - a family's departure is now only ever a real, explicitly
// entered End Time, never a guess.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `arrival-departure-missing-end-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `arrival-departure-missing-end-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function makeStudent(name, barcode) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES (?)`).run(`${name} Family`)).lastInsertRowid;
  return (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES (?, ?, 'student', ?)").run(name, barcode, familyId)
  ).lastInsertRowid;
}

test('a class with only a Start Time (no End Time) leaves Departure blank instead of fabricating one equal to the start time', async () => {
  const studentId = await makeStudent('No End Time Kid', 'no-end-time-kid');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Start Time Only Class', startTime: '10:00 AM' });
  await setEnrollment(classId, [studentId]);
  await syncDayMemberRosters('monday');

  const { arrival, departure } = await arrivalDepartureLabels(studentId, 'monday');
  assert.equal(arrival, '10:00 AM', 'arrival should still resolve from the real start time');
  assert.equal(departure, null, 'departure must stay blank rather than defaulting to the start time');
});

test('two families in different hours with real start/end times get their own, different windows - not both collapsed to the same one', async () => {
  const earlyKidId = await makeStudent('Early Hour Kid', 'early-hour-kid');
  const lateKidId = await makeStudent('Late Hour Kid', 'late-hour-kid');

  const earlyClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Early Class', startTime: '9:00 AM', endTime: '9:45 AM' });
  const lateClassId = await createClass({ day: 'monday', hourPosition: 2, className: 'Late Class', startTime: '11:00 AM', endTime: '11:45 AM' });
  await setEnrollment(earlyClassId, [earlyKidId]);
  await setEnrollment(lateClassId, [lateKidId]);
  await syncDayMemberRosters('monday');

  const earlyLabels = await arrivalDepartureLabels(earlyKidId, 'monday');
  const lateLabels = await arrivalDepartureLabels(lateKidId, 'monday');

  assert.deepEqual(earlyLabels, { arrival: '9:00 AM', departure: '9:45 AM' });
  assert.deepEqual(lateLabels, { arrival: '11:00 AM', departure: '11:45 AM' });
  assert.notDeepEqual(earlyLabels, lateLabels, 'two families in different hours must not show the identical arrival/departure');
});

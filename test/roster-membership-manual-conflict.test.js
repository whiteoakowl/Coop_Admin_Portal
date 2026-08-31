// Regression coverage for two real bug reports that turned out to share
// one root cause:
//   1. "Could not add member: duplicate key value violates unique
//      constraint 'roster_members_pkey'" every time a class's roster
//      changed (routes/admin-class-schedule.js's /roster/add route,
//      which already had a try/catch surfacing the raw error).
//   2. A generic "Something went wrong" page just saving a class (e.g.
//      after setting an assistant slot count) - the same underlying
//      crash, just hit through updateClass's own syncDayMemberRosters
//      call, which had no try/catch to surface it.
// Root cause: setRosterMembership (utils/classSchedule.js) only checked
// 'auto'-sourced rows for "is this member already on the roster" before
// inserting a fresh 'auto' row - but roster_members' primary key is
// (roster_id, member_id) with no idea what `source` a row has. A member
// already on a roster via a manual add (source='manual', from the
// Attendance page's own Add Member action - addManualRosterMember)
// looked "not there yet" to that check, so the very next auto-resync
// (enrolling/removing a student, staffing changes, or literally any
// class edit) tried to INSERT a second row for the same pair and
// collided with the PK.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `roster-membership-manual-conflict-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `roster-membership-manual-conflict-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, updateClass, addManualRosterMember, ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('enrolling a student who was already manually added to that class\'s own roster does not crash, and keeps them tagged manual', async () => {
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Manual Then Enrolled', 'manual-then-enrolled', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Manual Conflict Class' });
  const cls = await db.prepare('SELECT roster_id FROM classes WHERE id = ?').get(classId);

  // The admin manually added this student to the class's own roster via
  // the Attendance page BEFORE ever formally enrolling them - a real,
  // supported action (routes/admin-rosters.js's Add Member, backed by
  // this exact function).
  await addManualRosterMember(cls.roster_id, studentId);

  // Now formally enrolling them (the class roster's own "+ Add Member"
  // dialog, or checking them on the Manage page) used to throw here.
  await assert.doesNotReject(() => setEnrollment(classId, [studentId]));

  const rows = await db.prepare('SELECT member_id, source FROM roster_members WHERE roster_id = ? AND member_id = ?').all(cls.roster_id, studentId);
  assert.equal(rows.length, 1, 'exactly one roster_members row for this pair, not a duplicate');
  assert.equal(rows[0].source, 'manual', 'a manually-added member survives the auto-resync unchanged, per setRosterMembership\'s own contract');
});

test('unenrolling that same student afterward does not crash either, and the manual row is untouched', async () => {
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Manual Then Unenrolled', 'manual-then-unenrolled', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Manual Unenroll Class' });
  const cls = await db.prepare('SELECT roster_id FROM classes WHERE id = ?').get(classId);

  await addManualRosterMember(cls.roster_id, studentId);
  await setEnrollment(classId, [studentId]);
  // Now un-enroll (empty roster) - setRosterMembership's remove pass
  // only ever touches 'auto' rows, so the manual add should survive.
  await assert.doesNotReject(() => setEnrollment(classId, []));

  const rows = await db.prepare('SELECT member_id, source FROM roster_members WHERE roster_id = ? AND member_id = ?').all(cls.roster_id, studentId);
  assert.equal(rows.length, 1, 'the manual row is never removed by an auto-resync, even after unenrolling');
  assert.equal(rows[0].source, 'manual');
});

test('saving any class edit does not crash when a roster member on that day was added manually', async () => {
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Manual Day Roster Member', 'manual-day-roster', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Edit Save Class' });
  await setEnrollment(classId, [studentId]);

  // Manually add the same student to the day's own Student roster too
  // (a separate roster_id from the class's own - the Attendance page's
  // Student tab for this day) - updateClass's syncDayMemberRosters call
  // resyncs this roster on every single class save, regardless of which
  // field changed.
  const dayStudentRosterId = await ensureDayRoster('monday', 'student');
  await db.prepare('DELETE FROM roster_members WHERE roster_id = ? AND member_id = ?').run(dayStudentRosterId, studentId);
  await addManualRosterMember(dayStudentRosterId, studentId);

  // Saving the class - e.g. setting an assistant slot count - used to
  // 500 here with no error page at all (routes/admin-class-schedule.js's
  // POST /class-schedule/classes/:id had no try/catch around this).
  await assert.doesNotReject(() =>
    updateClass(classId, {
      day: 'monday',
      hourPosition: 3,
      className: 'Edit Save Class',
      assistantSlots: 2,
    })
  );

  const rows = await db.prepare('SELECT member_id, source FROM roster_members WHERE roster_id = ? AND member_id = ?').all(dayStudentRosterId, studentId);
  assert.equal(rows.length, 1, 'still exactly one row for this member on the day roster');
});

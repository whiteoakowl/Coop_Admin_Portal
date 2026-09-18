// Real bug report: "Monday/Wednesday attendance. If someone is manually
// deleted from the roster they are not automatically added back unless
// their schedule changes." Before this, POST /admin/rosters/:tab/remove-
// member/:memberId just deleted the roster_members row with nothing
// remembering the removal was deliberate - the next syncDayMemberRosters
// run (triggered by ANY other class's enrollment/staffing change that
// same day, not just this member's own) silently put them right back if
// they were still enrolled/staffed exactly as before. utils/
// classSchedule.js's roster_manual_removals tracking (see that migration
// and setRosterMembership's own comment) is what makes the removal stick
// until this specific member's own schedule genuinely changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-manual-removal-sticky-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-manual-removal-sticky-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff, ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function currentCsrf(cookie, tab) {
  const page = await request(app).get(`/admin/rosters?tab=${tab}`).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

test('a manually-removed student is not brought back by an unrelated resync, only by their own re-enrollment', async () => {
  const cookie = await loginAsAdmin();

  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Removal Sticky Kid', 'removal-sticky-kid', 'student')").run()
  ).lastInsertRowid;
  const otherStudentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Removal Sticky Other Kid', 'removal-sticky-other-kid', 'student')").run()
  ).lastInsertRowid;

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Removal Sticky Class' });
  const otherClassId = await createClass({ day: 'monday', hourPosition: 2, className: 'Removal Sticky Other Class' });
  await setEnrollment(classId, [studentId]);

  const studentRosterId = await ensureDayRoster('monday', 'student');
  const onRoster = () => db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(studentRosterId, studentId);

  assert.ok(await onRoster(), 'the student should start on the Monday Student roster via their own enrollment');

  const removeCsrf = await currentCsrf(cookie, 'monday-student');
  const removeRes = await request(app)
    .post(`/admin/rosters/monday-student/remove-member/${studentId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: removeCsrf });
  assert.equal(removeRes.status, 302);
  assert.equal(await onRoster(), undefined, 'the student should be off the roster immediately after manual removal');

  const removalRow = await db.prepare('SELECT 1 FROM roster_manual_removals WHERE roster_id = ? AND member_id = ?').get(studentRosterId, studentId);
  assert.ok(removalRow, 'the removal should be recorded so a routine resync does not silently undo it');

  // An UNRELATED enrollment change on the SAME day - the exact scenario
  // from the bug report ("not automatically added back unless their
  // schedule changes" - someone else's schedule changing doesn't count).
  await setEnrollment(otherClassId, [otherStudentId]);
  assert.equal(await onRoster(), undefined, 'an unrelated class\'s enrollment change must not bring the removed student back');

  const resyncCsrf = await currentCsrf(cookie, 'monday-student');
  await request(app).post('/admin/rosters/monday/resync').set('Cookie', cookie).type('form').send({ tab: 'monday-student', _csrf: resyncCsrf });
  assert.equal(await onRoster(), undefined, 'even an explicit "Resync" of the whole day must not bring the removed student back on its own');

  // Re-submitting the SAME, unchanged enrollment isn't actually a
  // schedule change for this student, so it must not clear the removal
  // either - only a genuine change should.
  await setEnrollment(classId, [studentId]);
  assert.equal(await onRoster(), undefined, "resubmitting the same, unchanged enrollment isn't a real schedule change and must not undo the removal");

  // THEIR OWN schedule genuinely changing (enrolling in a NEW class)
  // should override the removal, per the bug report's own "unless their
  // schedule changes."
  await setEnrollment(otherClassId, [otherStudentId, studentId]);
  assert.ok(await onRoster(), "enrolling the student in a class they weren't in before should put them back on the roster");
  assert.equal(
    await db.prepare('SELECT 1 FROM roster_manual_removals WHERE roster_id = ? AND member_id = ?').get(studentRosterId, studentId),
    undefined,
    'the removal marker itself should be cleared once their schedule genuinely changed'
  );
});

test('a manually-removed staff member is not brought back except by their own staff assignment changing', async () => {
  const cookie = await loginAsAdmin();

  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Removal Sticky Teacher', 'removal-sticky-teacher', 'parent')").run()
  ).lastInsertRowid;
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Removal Sticky Teacher Kid', 'removal-sticky-teacher-kid', 'student')").run()
  ).lastInsertRowid;

  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Removal Sticky Teacher Class' });
  await addStaff(classId, teacherId, 'teacher');

  const parentRosterId = await ensureDayRoster('wednesday', 'parent');
  const onRoster = () => db.prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?').get(parentRosterId, teacherId);
  assert.ok(await onRoster(), 'the teacher should start on the Wednesday Parent roster via their own staff assignment');

  const removeCsrf = await currentCsrf(cookie, 'wednesday-parent');
  await request(app).post(`/admin/rosters/wednesday-parent/remove-member/${teacherId}`).set('Cookie', cookie).type('form').send({ _csrf: removeCsrf });
  assert.equal(await onRoster(), undefined, 'the teacher should be off the roster immediately after manual removal');

  // An unrelated enrollment change on the same day must not bring them
  // back.
  await setEnrollment(classId, [studentId]);
  assert.equal(await onRoster(), undefined, 'an unrelated enrollment change must not bring the removed teacher back');

  // Their OWN staff assignment changing (re-added as staff) should
  // override the removal.
  await addStaff(classId, teacherId, 'teacher');
  assert.ok(await onRoster(), 're-assigning the teacher to their own class should put them back on the roster');
});

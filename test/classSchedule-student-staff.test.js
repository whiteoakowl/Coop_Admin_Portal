// Coverage for a feature request: a homeschool co-op commonly has a teen
// student teaching or assisting a class alongside (or instead of) a
// parent, so the Teacher/Assistant picker (activeMembersForStaff, used by
// the Add Class dialog, the class roster's own "+ Add Member" popup, the
// per-class Manage page, and the bulk class import) now includes active
// students, not just parents. A student staffing a class must still show
// up on the day's STUDENT roster like any other student, not the Parent
// roster - class_staff previously assumed every member in it was a
// parent (see syncDayMemberRosters's own history), which would have
// silently misfiled a student teacher/assistant onto the wrong roster.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classSchedule-student-staff-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classSchedule-student-staff-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, addStaff, activeMembersForStaff, ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('activeMembersForStaff includes both active parents and active students, tagged by member_type', async () => {
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Staff Picker Parent', 'staff-picker-parent', 'parent')").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Staff Picker Student', 'staff-picker-student', 'student')").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Staff Picker Inactive', 'staff-picker-inactive', 'parent', 0)").run();

  const staff = await activeMembersForStaff();
  const byName = new Map(staff.map((m) => [m.name, m.member_type]));
  assert.equal(byName.get('Staff Picker Parent'), 'parent');
  assert.equal(byName.get('Staff Picker Student'), 'student');
  assert.ok(!byName.has('Staff Picker Inactive'), 'an inactive member should never be offered as a staffing option');
});

test('a student assigned as a class Teacher lands on the day\'s Student roster, not the Parent roster', async () => {
  const teenId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Teen Teacher', 'teen-teacher', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Teen-Taught Class' });
  await addStaff(classId, teenId, 'teacher');

  const studentRosterId = await ensureDayRoster('monday', 'student');
  const parentRosterId = await ensureDayRoster('monday', 'parent');
  const studentMemberIds = (await db.prepare('SELECT member_id FROM roster_members WHERE roster_id = ?').all(studentRosterId)).map((r) => r.member_id);
  const parentMemberIds = (await db.prepare('SELECT member_id FROM roster_members WHERE roster_id = ?').all(parentRosterId)).map((r) => r.member_id);

  assert.ok(studentMemberIds.includes(teenId), 'the student teacher should be on the Student roster');
  assert.ok(!parentMemberIds.includes(teenId), 'the student teacher must not end up on the Parent roster just because class_staff historically only ever held parents');
});

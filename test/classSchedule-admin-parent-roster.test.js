// Coverage for a real bug report: "admins should still be considered
// parents everywhere. they aren't being included in the monday/wednesday
// rosters." primaryParentIdsByFamily (utils/classSchedule.js), used by
// syncDayMemberRosters (see classSchedule-parent-roster-family-wide.test.js
// for the plain-parent version of this same "family-wide" roster rule) to
// pick who represents a family on the day's roster, used to only look at
// member_type = 'parent' rows - a family whose only adult record is
// admin-typed (not a separate 'parent' record) had nobody to represent it,
// so their enrolled kid never put them on the roster despite being at the
// co-op that day, same as any other parent would be.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-parent-roster-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-parent-roster-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');
const { rosterMembers } = require('../utils/rosterGrid');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('an admin who is their family\'s only adult member record is added to the day\'s Parent roster because their kid is enrolled', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Admin-Only Roster Family')").run()).lastInsertRowid;
  const adminId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Admin Parent', 'admin-roster-parent', 'admin', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Admin Roster Kid', 'admin-roster-kid', 'student', ?)")
      .run(familyId)
  ).lastInsertRowid;

  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Admin Roster Class' });
  await setEnrollment(classId, [studentId]);

  const rosterRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'wednesday_parent_roster_id'").get();
  const parentRosterId = parseInt(rosterRow.value, 10);
  const members = await rosterMembers(parentRosterId);
  const ids = members.map((m) => m.id);

  assert.ok(ids.includes(adminId), 'the enrolled student\'s admin-typed parent should be on the Wednesday Parent roster');
});

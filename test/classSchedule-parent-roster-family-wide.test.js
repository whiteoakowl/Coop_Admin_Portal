// Coverage for a bug report: a day's Parent roster (utils/classSchedule.js's
// syncDayMemberRosters) used to only include a parent who was themselves
// teaching/assisting a class or floating that day - a parent with no class
// assignment of their own, whose kid is simply enrolled in a class that
// day, was never added, even though they're obviously at the co-op
// dropping off/picking up. Parents should be added to the day's roster if
// ANYONE in their family has a class that day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-roster-family-wide-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-roster-family-wide-test-uploads-${process.pid}`);
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

test('a parent with no class assignment of their own is added to the day\'s Parent roster because their kid is enrolled', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Family-Wide Roster Family')").run()).lastInsertRowid;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Uninvolved Parent', 'family-wide-parent', 'parent', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Family-Wide Kid', 'family-wide-kid', 'student', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const otherParentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unrelated Parent', 'family-wide-unrelated-parent', 'parent')").run()
  ).lastInsertRowid;

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Family-Wide Roster Class' });
  await setEnrollment(classId, [studentId]);

  const rosterRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'monday_parent_roster_id'").get();
  const parentRosterId = parseInt(rosterRow.value, 10);
  const members = await rosterMembers(parentRosterId);
  const ids = members.map((m) => m.id);

  assert.ok(ids.includes(parentId), 'the enrolled student\'s parent should be on the Monday Parent roster, even with no class assignment of their own');
  assert.ok(!ids.includes(otherParentId), 'a parent unrelated to any enrolled student should NOT be added');
});

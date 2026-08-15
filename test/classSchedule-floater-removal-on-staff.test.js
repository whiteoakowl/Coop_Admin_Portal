// Coverage for a new bug report/feature: a parent who is already on that
// day's Floater Assignments list for a given hour, and then gets added as
// a class's teacher/assistant for that SAME hour, is no longer free to
// float it - they should be automatically removed from that one hour's
// floater section (utils/classSchedule.js's addStaff -> new
// removeFromFloaterForHour helper), without touching any OTHER hour they
// might also be floating that day. Deliberately narrow in scope, per the
// user's own clarification: this only fires on the "added as teacher/
// assistant" event itself, not as some broader recurring recompute, and
// has nothing to do with the separate day-of substitute auto-assignment
// system (utils/substitutes.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `floater-removal-on-staff-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `floater-removal-on-staff-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, addStaff } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection, membersForSection } = require('../utils/volunteers');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

test('addStaff removes the new teacher/assistant from that SAME hour\'s floater section, leaving other hours alone', async (t) => {
  const parentId = await makeMember('Floater Turned Teacher', 'floater-turned-teacher');

  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  const hour1 = sections.find((s) => s.position === 1);
  const hour2 = sections.find((s) => s.position === 2);

  await addMemberToSection(list.id, parentId, hour1.id);
  await addMemberToSection(list.id, parentId, hour2.id);

  await t.test('sanity check: the parent floats both hour 1 and hour 2 before any class assignment', async () => {
    assert.ok((await membersForSection(list.id, hour1.id)).some((m) => m.id === parentId));
    assert.ok((await membersForSection(list.id, hour2.id)).some((m) => m.id === parentId));
  });

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Floater Removal Test Class' });
  await addStaff(classId, parentId, 'teacher');

  await t.test('the parent is removed from hour 1\'s floater section (now teaching that hour)', async () => {
    assert.ok(!(await membersForSection(list.id, hour1.id)).some((m) => m.id === parentId));
  });

  await t.test('the parent is STILL on hour 2\'s floater section (untouched, different hour)', async () => {
    assert.ok((await membersForSection(list.id, hour2.id)).some((m) => m.id === parentId));
  });

  await t.test('the parent is now on the class\'s staff', async () => {
    const staff = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(classId, parentId);
    assert.ok(staff);
    assert.equal(staff.role, 'teacher');
  });
});

test('addStaff is a no-op against the floater list when the new staff member was never on it', async () => {
  const parentId = await makeMember('Never A Floater', 'never-a-floater');
  const classId = await createClass({ day: 'wednesday', hourPosition: 2, className: 'No Floater History Class' });

  // Must not throw even though this parent has no volunteer_members rows
  // at all for Wednesday's list.
  await assert.doesNotReject(addStaff(classId, parentId, 'assistant'));

  const staff = await db.prepare('SELECT * FROM class_staff WHERE class_id = ? AND member_id = ?').get(classId, parentId);
  assert.equal(staff.role, 'assistant');
});

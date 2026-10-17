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
const { createClass, addStaff, createSemester } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection, membersForSection } = require('../utils/volunteers');
const { setActiveKioskSemesterId } = require('../utils/kioskSettings');

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

// A real bug report: "Fall Wednesday and fall Monday is pulling emptying
// teaching and assistant positions from spring Monday and spring
// Wednesday... Could also be because I duplicated the classes from one
// grid to the other?" - exactly right. addStaff used to always clear the
// new teacher/assistant off whichever semester Settings > Kiosk currently
// has ACTIVE, not off the class's own semester, so staffing a Fall class
// while Spring happened to be the active kiosk semester wiped that same
// day/hour's floater assignment on Spring's own list instead of Fall's.
test('addStaff only touches the floater list for the CLASS\'s own semester, never a different semester that happens to be active', async (t) => {
  const springSemester = await createSemester('Spring Test');
  const fallSemester = await createSemester('Fall Test');
  const parentId = await makeMember('Cross Semester Parent', 'cross-semester-parent');

  const springList = await getListByDay('monday', springSemester.id);
  const fallList = await getListByDay('monday', fallSemester.id);
  const springHour1 = (await sectionsForList(springList.id)).find((s) => s.position === 1);
  const fallHour1 = (await sectionsForList(fallList.id)).find((s) => s.position === 1);

  // The same parent floats Monday hour 1 on BOTH semesters' own lists -
  // a real admin duplicating a day's classes across semesters would have
  // duplicated its floater list membership right along with it.
  await addMemberToSection(springList.id, parentId, springHour1.id);
  await addMemberToSection(fallList.id, parentId, fallHour1.id);

  // Spring is the active kiosk semester while we staff a FALL class -
  // the exact scenario the bug report describes.
  await setActiveKioskSemesterId(springSemester.id);

  const fallClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Fall Monday Class', semesterId: fallSemester.id });
  await addStaff(fallClassId, parentId, 'teacher');

  await t.test('the parent is removed from FALL\'s own Monday hour 1 floater section (now teaching it there)', async () => {
    assert.ok(!(await membersForSection(fallList.id, fallHour1.id)).some((m) => m.id === parentId));
  });

  await t.test('the parent is STILL on SPRING\'s own Monday hour 1 floater section, untouched', async () => {
    assert.ok((await membersForSection(springList.id, springHour1.id)).some((m) => m.id === parentId));
  });
});

// A real user request: "make sure every list and search of members across
// the website reads in ABC order according to the last name." Before this,
// most member lists sorted by SQL `ORDER BY LOWER(name)` - alphabetical by
// FIRST name (names are stored as one "First Last" string), not last name.
// This pins the fix down across a representative sample of the call sites
// that were touched (utils/members.js, classSchedule.js, volunteers.js,
// schedule.js, search.js, library.js), using two members whose first-name
// and last-name order deliberately disagree - "Zoe Adams" before "Alice
// Zimmer" is only correct under last-name sorting.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `last-name-sort-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `last-name-sort-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { activeParentOptions, familyOf, membersWithMedicalNotes, setMemberFamily } = require('../utils/members');
const { createClass, getClass, setEnrollment, addStaff, activeStudents, activeMembersForStaff } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection, membersForList, membersForSection } = require('../utils/volunteers');
const { scheduleList } = require('../utils/schedule');
const { globalSearch } = require('../utils/search');
const { checkoutItems, membersWithActiveCheckouts } = require('../utils/library');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

// "Zoe Adams" sorts before "Alice Zimmer" by last name (Adams < Zimmer)
// but after it by first name (Alice < Zoe) - names picked specifically so
// a first-name sort and a last-name sort disagree on the order.
async function makeMember(name, memberType, extra) {
  extra = extra || {};
  const cols = ['name', 'barcode', 'member_type', ...Object.keys(extra)];
  const placeholders = cols.map(() => '?').join(', ');
  const values = [name, `BC-${name.replace(/\s+/g, '')}`, memberType, ...Object.values(extra)];
  return (await db.prepare(`INSERT INTO members (${cols.join(', ')}) VALUES (${placeholders})`).run(...values)).lastInsertRowid;
}

function namesInOrder(list) {
  return list.map((m) => m.name || m.memberName);
}

test('activeParentOptions sorts parents by last name, not first', async () => {
  await makeMember('Zoe Adams', 'parent');
  await makeMember('Alice Zimmer', 'parent');
  const names = namesInOrder(await activeParentOptions());
  assert.ok(names.indexOf('Zoe Adams') < names.indexOf('Alice Zimmer'), `expected Adams before Zimmer, got ${names.join(', ')}`);
});

test('familyOf sorts family members by last name', async () => {
  const primary = await makeMember('Zoe Adams Family Anchor', 'parent');
  const childZ = await makeMember('Zed Zimmer', 'student');
  const childA = await makeMember('Amy Ackerman', 'student');

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Test Sort Family')).lastInsertRowid;
  await setMemberFamily(primary, familyId);
  await setMemberFamily(childA, familyId);
  await setMemberFamily(childZ, familyId);

  const names = namesInOrder(await familyOf(primary));
  assert.deepEqual(names, ['Amy Ackerman', 'Zed Zimmer'], `expected Ackerman before Zimmer, got ${names.join(', ')}`);
});

test('membersWithMedicalNotes sorts by last name', async () => {
  await makeMember('Gina Yoder', 'student', { medical_notes: 'Peanut allergy' });
  await makeMember('Bob Abrams', 'student', { medical_notes: 'Bee sting allergy' });
  const names = namesInOrder(await membersWithMedicalNotes());
  const abramsIdx = names.indexOf('Bob Abrams');
  const yoderIdx = names.indexOf('Gina Yoder');
  assert.ok(abramsIdx >= 0 && yoderIdx >= 0 && abramsIdx < yoderIdx, `expected Abrams before Yoder, got ${names.join(', ')}`);
});

test('class roster (getClass students/staff) and staff/student pickers sort by last name', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Sort Test Class', room: 'Room 9' });
  const studentZ = await makeMember('Zane Baker', 'student');
  const studentA = await makeMember('Amy Zorn', 'student');
  await setEnrollment(classId, [studentZ, studentA]);

  const teacherZ = await makeMember('Zack Carter', 'parent');
  const teacherA = await makeMember('Anna Yates', 'parent');
  await addStaff(classId, teacherZ, 'teacher');
  await addStaff(classId, teacherA, 'teacher');

  const cls = await getClass(classId);
  const rosterNames = namesInOrder(cls.students);
  assert.deepEqual(rosterNames, ['Zane Baker', 'Amy Zorn'], `expected Baker before Zorn, got ${rosterNames.join(', ')}`);

  const staffNames = namesInOrder(cls.staff.filter((s) => s.role === 'teacher'));
  assert.deepEqual(staffNames, ['Zack Carter', 'Anna Yates'], `expected Carter before Yates, got ${staffNames.join(', ')}`);

  const activeStudentNames = namesInOrder(await activeStudents());
  assert.ok(activeStudentNames.indexOf('Zane Baker') < activeStudentNames.indexOf('Amy Zorn'));

  const staffPickerNames = namesInOrder(await activeMembersForStaff());
  assert.ok(staffPickerNames.indexOf('Zack Carter') < staffPickerNames.indexOf('Anna Yates'));
});

test('Floater Teams/Setup-Cleanup member lists (membersForList/membersForSection) sort by last name', async () => {
  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  const section = sections[0];
  const memberZ = await makeMember('Zelda Ford', 'parent');
  const memberA = await makeMember('Amara Young', 'parent');
  await addMemberToSection(list.id, memberZ, section.id);
  await addMemberToSection(list.id, memberA, section.id);

  const listNames = namesInOrder(await membersForList(list.id));
  assert.ok(listNames.indexOf('Zelda Ford') < listNames.indexOf('Amara Young'), `expected Ford before Young, got ${listNames.join(', ')}`);

  const sectionNames = namesInOrder(await membersForSection(list.id, section.id));
  assert.ok(sectionNames.indexOf('Zelda Ford') < sectionNames.indexOf('Amara Young'));
});

test('Class Schedules table (scheduleList) sorts by last name', async () => {
  await makeMember('Zoya Nash', 'student');
  await makeMember('Nina Zale', 'student');
  const names = (await scheduleList({})).map((r) => r.member.name);
  assert.ok(names.indexOf('Zoya Nash') < names.indexOf('Nina Zale'), `expected Nash before Zale, got ${names.join(', ')}`);
});

test('global admin search (globalSearch) sorts by last name', async () => {
  await makeMember('Zed Miller', 'parent');
  await makeMember('Mia Zephyr', 'parent');
  const { members } = await globalSearch('Z');
  const names = members.map((r) => r.name);
  const millerIdx = names.indexOf('Zed Miller');
  const zephyrIdx = names.indexOf('Mia Zephyr');
  assert.ok(millerIdx >= 0 && zephyrIdx >= 0 && millerIdx < zephyrIdx, `expected Miller before Zephyr, got ${names.join(', ')}`);
});

test('Library checked-out members list (membersWithActiveCheckouts) sorts by last name', async () => {
  const item = await db.prepare("INSERT INTO library_items (title, barcode) VALUES ('Sort Test Book', 'LIB-SORT-1')").run();
  const memberZ = await makeMember('Zoe Harris', 'student');
  const memberA = await makeMember('Ana Young', 'student');
  await checkoutItems(memberZ, [item.lastInsertRowid], null);
  await checkoutItems(memberA, [item.lastInsertRowid], null);
  const names = namesInOrder(await membersWithActiveCheckouts());
  const harrisIdx = names.indexOf('Zoe Harris');
  const youngIdx = names.indexOf('Ana Young');
  assert.ok(harrisIdx >= 0 && youngIdx >= 0 && harrisIdx < youngIdx, `expected Harris before Young, got ${names.join(', ')}`);
});

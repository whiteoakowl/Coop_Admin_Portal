// A real request: "if class assistant says 1 and there are 0 assistants
// signed for that class, then the positions should appear on the floater
// list each week until someone is added as an assistant to that class
// roster... this should work for number of teachers as well. this also
// works if the assistant number is set to two, only 1 assistant is signed
// up for the class. then 1 position should show up on the floater list as
// needing to be filled." Covers classVacancySlots directly (the shortfall
// math) and substituteBoard end-to-end (the slots actually reaching the
// board, getting an auto-suggested floater once a date is picked, and
// disappearing again once the roster catches up).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-class-vacancy-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-class-vacancy-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, addStaff, gridForDay } = require('../utils/classSchedule');
const { substituteBoard, classVacancyEntriesForClass, classVacancySlotId } = require('../utils/substitutes');

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

async function vacancySlotsForClass(day, classId) {
  const grid = await gridForDay(day);
  let cls;
  for (const hourGroup of grid) {
    cls = hourGroup.classes.find((c) => c.id === classId);
    if (cls) break;
  }
  return classVacancyEntriesForClass(cls);
}

test('assistant_slots=1, 0 signed up: one vacancy slot appears, tagged "Assistant needed (0 of 1 filled)"', async () => {
  const day = 'monday';
  const classId = await createClass({
    day, hourPosition: 1, className: 'Art Class', assistantSlots: 1,
  });

  const vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 1);
  assert.equal(vacancies[0].reason, 'Assistant needed (0 of 1 filled)');
});

test('assistant_slots=2, 1 signed up: exactly one vacancy slot appears, not two', async () => {
  const day = 'monday';
  const classId = await createClass({
    day, hourPosition: 2, className: 'Music Class', assistantSlots: 2,
  });
  const assistant = await makeMember('One Assistant', 'vacancy-one-assistant');
  await addStaff(classId, assistant, 'assistant');

  const vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 1);
  assert.equal(vacancies[0].reason, 'Assistant needed (1 of 2 filled)');
});

test('assistant_slots fully filled: zero vacancy slots', async () => {
  const day = 'monday';
  const classId = await createClass({
    day, hourPosition: 3, className: 'Science Class', assistantSlots: 1,
  });
  const assistant = await makeMember('Filled Assistant', 'vacancy-filled-assistant');
  await addStaff(classId, assistant, 'assistant');

  const vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 0);
});

test('teacher_slots works the same way as assistant_slots', async () => {
  const day = 'monday';
  const classId = await createClass({
    day, hourPosition: 4, className: 'History Class', teacherSlots: 1,
  });

  let vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 1);
  assert.equal(vacancies[0].reason, 'Teacher needed (0 of 1 filled)');

  const teacher = await makeMember('The Teacher', 'vacancy-the-teacher');
  await addStaff(classId, teacher, 'teacher');

  vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 0, 'the vacancy should disappear once someone is added to the roster');
});

test('no cap set (teacher_slots/assistant_slots null): never generates a vacancy slot', async () => {
  const day = 'wednesday';
  const classId = await createClass({ day, hourPosition: 1, className: 'Uncapped Class' });

  const vacancies = await vacancySlotsForClass(day, classId);
  assert.equal(vacancies.length, 0);
});

test('substituteBoard surfaces the vacancy slot alongside jobs/class-absence slots and auto-suggests a floater once a date is picked', async () => {
  const day = 'wednesday';
  const classId = await createClass({
    day, hourPosition: 2, className: 'Drama Class', room: 'R12', assistantSlots: 1,
  });

  const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
  const list = await getListByDay(day);
  const hour2 = (await sectionsForList(list.id)).find((s) => s.position === 2);
  const floater = await makeMember('Board Floater', 'vacancy-board-floater');
  await addMemberToSection(list.id, floater, hour2.id);

  const date = '2026-09-02'; // a Wednesday
  const board = await substituteBoard(day, date);
  const hour = board.find((h) => h.position === 2);
  const slot = hour.slots.find((s) => s.slotType === 'vacancy' && s.slotId === classVacancySlotId(classId, 'assistant', 1));

  assert.ok(slot, 'the vacancy slot should be on the board');
  assert.equal(slot.label, 'Drama Class');
  assert.equal(slot.room, 'R12');
  assert.ok(slot.assigned, 'the lone eligible floater should get auto-suggested');
  assert.equal(slot.assigned.id, floater);
  assert.equal(slot.assigned.status, 'pending');

  await addStaff(classId, floater, 'assistant');
  const boardAfter = await substituteBoard(day, date);
  const hourAfter = boardAfter.find((h) => h.position === 2);
  const slotAfter = hourAfter.slots.find((s) => s.slotType === 'vacancy' && s.slotId === classVacancySlotId(classId, 'assistant', 1));
  assert.equal(slotAfter, undefined, 'the vacancy slot should disappear once the roster catches up');
});

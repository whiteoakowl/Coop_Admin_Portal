// A real request: "I need to be able to switch between semester views on
// floaters, setup cleanup, attendance, classes etc. Drop down on all
// these pages should be fall 2026 - Monday, fall 2026 Wednesday." Covers
// listScheduleCombos (utils/classSchedule.js) - the shared list every
// page's new semester+day picker renders its options from, one entry per
// class_schedules row.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `class-schedule-list-combos-test-db-${process.pid}.db`);
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const db = require('../db');
const { createSemester, createClassSchedule, listScheduleCombos } = require('../utils/classSchedule');

test.before(() => db.ready);

test('listScheduleCombos labels a semester-tagged combo "<Semester> - <Day>", newest semester first, calendar day order within a semester', async () => {
  const fall = await createSemester('Fall 2026');
  const spring = await createSemester('Spring 2027');
  await createClassSchedule({ title: 'Wednesday', dayOfWeek: 'wednesday', semesterId: fall.id });
  await createClassSchedule({ title: 'Monday', dayOfWeek: 'monday', semesterId: fall.id });
  await createClassSchedule({ title: 'Tuesday', dayOfWeek: 'tuesday', semesterId: spring.id });

  const combos = await listScheduleCombos();
  const fallCombos = combos.filter((c) => c.semesterId === fall.id);
  const springCombos = combos.filter((c) => c.semesterId === spring.id);

  assert.deepEqual(fallCombos.map((c) => c.day), ['monday', 'wednesday'], 'Fall 2026 combos are in calendar day order, not creation order');
  assert.equal(fallCombos[0].label, 'Fall 2026 - Monday');
  assert.equal(fallCombos[1].label, 'Fall 2026 - Wednesday');
  assert.equal(springCombos[0].label, 'Spring 2027 - Tuesday');

  // Spring 2027 (newer) sorts before Fall 2026 (older) among semester-tagged combos.
  const springIdx = combos.findIndex((c) => c.semesterId === spring.id);
  const fallIdx = combos.findIndex((c) => c.semesterId === fall.id);
  assert.ok(springIdx < fallIdx, 'the newer semester (Spring 2027) sorts before the older one (Fall 2026)');
});

test('listScheduleCombos labels an untagged (no-semester) combo with just the day name, and sorts every untagged combo after every semester-tagged one', async () => {
  const fall = await createSemester('Fall 2026 Untagged Test');
  await createClassSchedule({ title: 'Thursday', dayOfWeek: 'thursday', semesterId: fall.id });
  await createClassSchedule({ title: 'Friday (no semester)', dayOfWeek: 'friday', semesterId: null });

  const combos = await listScheduleCombos();
  const untagged = combos.find((c) => c.day === 'friday' && c.semesterId == null);
  assert.ok(untagged, 'the untagged Friday combo exists');
  assert.equal(untagged.label, 'Friday');

  const untaggedIdx = combos.indexOf(untagged);
  const everySemesterTaggedComboIsBeforeIt = combos.slice(0, untaggedIdx).every((c) => c.semesterId != null) || combos.every((c) => c.semesterId == null);
  // Every combo with a semester (there's at least Fall 2026 Untagged Test's Thursday) sorts before this one.
  const taggedAfter = combos.slice(untaggedIdx + 1).some((c) => c.semesterId != null);
  assert.equal(taggedAfter, false, 'no semester-tagged combo sorts after an untagged one');
});

test('listScheduleCombos carries each combo\'s own id, startDate, and endDate through untouched', async () => {
  const fall = await createSemester('Fall 2026 Dates Test');
  await createClassSchedule({ title: 'Monday', dayOfWeek: 'monday', semesterId: fall.id, startDate: '2026-08-24', endDate: '2026-12-11' });

  const combos = await listScheduleCombos();
  const combo = combos.find((c) => c.semesterId === fall.id && c.day === 'monday');
  assert.ok(combo.id, 'the combo carries its own class_schedules.id');
  assert.equal(combo.startDate, '2026-08-24');
  assert.equal(combo.endDate, '2026-12-11');
});

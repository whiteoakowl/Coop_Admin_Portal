// A real, live bug report: "There are a lot of running late floater
// assignments appearing on floaters needed assignments page. Nobody has
// submitted a late form for today." Root cause: utils/substitutes.js's
// isAutoLateForClass (and assignedIsOverdue, the same underlying
// function) compared a class hour's Eastern wall-clock start_time
// against `new Date().getHours() * 60 + getMinutes()` - the SERVER's own
// local clock, UTC in production (Netlify) - the exact same class of
// mistake utils/dates.js's own todayISO() comment already documents for
// calendar-date rollover. UTC reads hours ahead of Eastern, so "5+
// minutes past the hour's start" was true almost the instant the
// calendar date matched, regardless of the real Eastern time of day -
// every teacher/assistant showed as running late all morning, with no
// late form ever submitted. Fixed by reading the current time through
// utils/dates.js's nowEasternMinutes() instead of the Date object's own
// UTC-local getHours()/getMinutes() - this exercises that fix through the
// real substituteBoard() entry point the Floater Assignments page uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-auto-late-eastern-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-auto-late-eastern-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, addStaff, saveHourLabels } = require('../utils/classSchedule');
const { substituteBoard } = require('../utils/substitutes');

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

async function slotForTeacher(day, date, teacherName) {
  const board = await substituteBoard(day, date);
  for (const hour of board) {
    const slot = hour.slots.find((s) => s.slotType === 'class' && s.reason.includes(teacherName));
    if (slot) return slot;
  }
  return null;
}

test('a teacher who has not checked in is NOT auto-flagged as late while it is still before their class start time in Eastern, even though the UTC server clock already reads past it', async (t) => {
  const day = 'monday';
  await saveHourLabels(day, ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM']);
  const classId = await createClass({ day, hourPosition: 1, className: 'Early Bird Art' });
  const teacher = await makeMember('Not Yet Late Teacher', 'not-yet-late-teacher');
  await addStaff(classId, teacher, 'teacher');

  // 12:30 PM UTC = 8:30 AM Eastern (EDT, UTC-4) - a plain `new Date()`
  // read on a UTC server would already show 12:30 (750 minutes), well
  // past the class's 9:00 AM start + 5 minutes (545) - exactly the false
  // positive this bug produced. The real Eastern time, 8:30 AM, is still
  // BEFORE the class has even started.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-07-08T12:30:00Z').getTime() });
  try {
    const monday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const slot = await slotForTeacher(day, monday, 'Not Yet Late Teacher');
    assert.equal(slot, null, 'must not show as running late before the real Eastern start time, even though the UTC clock alone would suggest otherwise');
  } finally {
    t.mock.timers.reset();
  }
});

test('the same teacher IS auto-flagged as late once it is genuinely 5+ minutes past their class start time in Eastern', async (t) => {
  const day = 'monday';
  await saveHourLabels(day, ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM']);
  const classId = await createClass({ day, hourPosition: 1, className: 'Genuinely Late Art' });
  const teacher = await makeMember('Genuinely Late Teacher', 'genuinely-late-teacher');
  await addStaff(classId, teacher, 'teacher');

  // 1:10 PM UTC = 9:10 AM Eastern (EDT, UTC-4) - 10 real minutes past the
  // class's 9:00 AM start, no check-in recorded.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-07-08T13:10:00Z').getTime() });
  try {
    const monday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const slot = await slotForTeacher(day, monday, 'Genuinely Late Teacher');
    assert.ok(slot, 'should show as running late once genuinely 5+ minutes past the real Eastern start time');
    assert.match(slot.reason, /running late: Genuinely Late Teacher/);
  } finally {
    t.mock.timers.reset();
  }
});

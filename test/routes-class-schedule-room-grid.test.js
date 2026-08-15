// Real coverage for four related room-grid bug reports/features:
//   1. "classes not lining up with the right time column" - the grid's
//      Hour column headers are now derived live from whatever classes
//      actually occupy each position (roomGridForDay), not a separately-
//      stored label that only got refreshed at import time and could go
//      stale the moment a second import or a manually-added class touched
//      the same position with a different real time.
//   2. "class cards should stretch through the next column depending on
//      when the class end time is" - a single class's own start/end time
//      can now span multiple hour columns on its own, without needing a
//      second matching database row (falls back to the older name/color/
//      grade adjacent-row merge when no end_time is set).
//   3. Drag-and-drop room row reordering (getRoomOrder/saveRoomOrder).
//   4. "the classes in the room 'kitchen' shows up as unassigned... i
//      can't edit the table to change the unassigned room name" - a class
//      with a blank room now surfaces "Unassigned" in roomsForDay() (so
//      it's offered as something Edit Room Numbers can rename), and
//      renameRoom() can rename FROM "Unassigned" to assign a real room to
//      every currently-blank-room class on that day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-room-grid-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-room-grid-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, roomGridForDay, roomsForDay, renameRoom, getRoomOrder } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('room-grid Hour column headers are derived live from actual class data, not a stale stored label', async () => {
  await createClass({ day: 'monday', hourPosition: 1, className: 'Live Label Class', room: 'Live Label Room', startTime: '9:15 AM' });

  // Deliberately corrupt the stored label a real import/Edit Hours save
  // would normally have kept in sync, to prove the header comes from the
  // live class data at render time, not this value.
  await db.prepare("UPDATE class_schedule_hours SET label = 'Some Stale Label' WHERE day = 'monday' AND position = 1").run();

  const grid = await roomGridForDay('monday');
  assert.equal(grid.hours.find((h) => h.position === 1).label, '9:15 AM', 'the header should reflect the real class start time, ignoring the stale stored label');
});

test('a class with an end_time crossing into a later column spans it, without a second database row', async (t) => {
  // Establishes hour position 3's real (derived) start time - the long
  // class below spans into hour 3 because its own 11:15 AM end_time
  // crosses this, not because of anything to do with this class itself.
  await createClass({ day: 'monday', hourPosition: 3, className: 'Anchor For Hour 3', room: 'Anchor Room', startTime: '10:45 AM' });
  const longClassId = await createClass({
    day: 'monday', hourPosition: 2, className: 'Long Span Class', room: 'Span Room', startTime: '10:00 AM', endTime: '11:15 AM',
  });

  await t.test('spans 2 columns (hour 2 into hour 3) based on its own end_time', async () => {
    const grid = await roomGridForDay('monday');
    const spanRoomRow = grid.rows.find((r) => r.room === 'Span Room');
    assert.ok(spanRoomRow, 'expected a Span Room row');
    const cell = spanRoomRow.cells.find((c) => c.classes.some((cls) => cls.id === longClassId));
    assert.ok(cell, 'expected a cell containing the long class');
    assert.equal(cell.span, 2, 'should span into hour 3, whose real start time (10:45 AM) the class\'s own 11:15 AM end_time crosses');
  });

  await t.test('a class with no end_time falls back to the old name/color/grade adjacent-row merge (regression)', async () => {
    const color = '#7BD2C6';
    await createClass({ day: 'monday', hourPosition: 3, className: 'Fallback Merge Class', room: 'Fallback Room', color, ageGroup: '1st' });
    await createClass({ day: 'monday', hourPosition: 4, className: 'Fallback Merge Class', room: 'Fallback Room', color, ageGroup: '1st' });

    const grid = await roomGridForDay('monday');
    const fallbackRow = grid.rows.find((r) => r.room === 'Fallback Room');
    assert.ok(fallbackRow);
    const mergedCell = fallbackRow.cells.find((c) => c.span === 2 && c.classes[0].class_name === 'Fallback Merge Class');
    assert.ok(mergedCell, 'two adjacent same-name/color/grade rows with no end_time should still merge, unchanged from before');
  });
});

test('room row drag-reorder', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await createClass({ day: 'wednesday', hourPosition: 1, className: 'Order Test A', room: 'Zebra Room' });
  await createClass({ day: 'wednesday', hourPosition: 1, className: 'Order Test B', room: 'Alpha Room' });

  await t.test('with no saved order, rooms fall back to alphabetical (existing default behavior)', async () => {
    const grid = await roomGridForDay('wednesday');
    assert.deepEqual(grid.rows.map((r) => r.room), ['Alpha Room', 'Zebra Room']);
  });

  await t.test('POST rooms/reorder saves a custom order the grid then follows', async () => {
    const res = await request(app)
      .post('/admin/class-schedule/wednesday/rooms/reorder')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
      .send({ rooms: ['Zebra Room', 'Alpha Room'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await getRoomOrder('wednesday'), ['Zebra Room', 'Alpha Room']);

    const grid = await roomGridForDay('wednesday');
    assert.deepEqual(grid.rows.map((r) => r.room), ['Zebra Room', 'Alpha Room'], 'the grid should follow the saved custom order instead of alphabetical');
  });

  await t.test('renaming a reordered room carries its position in the saved order', async () => {
    await renameRoom('wednesday', 'Zebra Room', 'Zulu Room');
    assert.deepEqual(await getRoomOrder('wednesday'), ['Zulu Room', 'Alpha Room']);

    const grid = await roomGridForDay('wednesday');
    assert.deepEqual(grid.rows.map((r) => r.room), ['Zulu Room', 'Alpha Room']);
  });

  await t.test('a newly-created room not yet in the saved order is appended alphabetically, not lost', async () => {
    await createClass({ day: 'wednesday', hourPosition: 2, className: 'Order Test C', room: 'Beta Room' });
    const grid = await roomGridForDay('wednesday');
    assert.deepEqual(grid.rows.map((r) => r.room), ['Zulu Room', 'Alpha Room', 'Beta Room']);
  });
});

test('a class with a blank room surfaces as "Unassigned" and can be renamed to a real room', async (t) => {
  const classId = await createClass({ day: 'monday', hourPosition: 4, className: 'No Room Class', room: '' });

  await t.test('roomsForDay includes the synthetic "Unassigned" entry', async () => {
    const rooms = await roomsForDay('monday');
    assert.ok(rooms.includes('Unassigned'), 'Unassigned should be offered as something Edit Room Numbers can rename, not silently unrenameable');
  });

  await t.test('the grid shows it under an "Unassigned" row', async () => {
    const grid = await roomGridForDay('monday');
    const unassignedRow = grid.rows.find((r) => r.room === 'Unassigned');
    assert.ok(unassignedRow);
    assert.ok(unassignedRow.cells.some((c) => c.classes.some((cls) => cls.id === classId)));
  });

  await t.test('renameRoom("Unassigned", "Kitchen") assigns every blank-room class that day to Kitchen', async () => {
    await renameRoom('monday', 'Unassigned', 'Kitchen');
    const cls = await db.prepare('SELECT room FROM classes WHERE id = ?').get(classId);
    assert.equal(cls.room, 'Kitchen');

    const grid = await roomGridForDay('monday');
    assert.ok(grid.rows.some((r) => r.room === 'Kitchen'));
    assert.equal(grid.rows.some((r) => r.room === 'Unassigned'), false, 'Unassigned should be gone once nothing has a blank room left');
  });
});

test('print view uses a condensed grade range and "<Day> Schedule" header text', async () => {
  const { cookie } = await loginAsAdmin();
  await createClass({ day: 'monday', hourPosition: 3, className: 'Print Grade Class', room: 'Print Room', ageGroup: '1st, 2nd, 3rd' });

  const res = await request(app).get('/admin/class-schedule/monday/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Monday Schedule/);
  assert.doesNotMatch(res.text, /Monday Class Schedule/);
  assert.match(res.text, /Grades 1-3/, 'should show a condensed grade range, not every individual grade listed out');
  assert.doesNotMatch(res.text, /1st, 2nd, 3rd/);
});

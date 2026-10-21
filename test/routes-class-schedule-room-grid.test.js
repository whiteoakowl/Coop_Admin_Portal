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

// A real bug report: "If a class is created or duplicated and it happens
// to fit in the same time frame and room as another class it should
// still show up on the class list so It can be edited." The span test
// above only ever exercised a long class spanning into a LATER column
// that had nothing else in it; this covers the actual bug - the SAME
// room, with a different class already sitting in the later column the
// long class's own end_time would otherwise claim.
test('a class spanning into a later hour based on its own end_time does not swallow a different class already occupying that hour, in the same room', async (t) => {
  // Hour 2's real (derived) start time, from this class's own 10:00 AM
  // start - the long class below spans into hour 2 purely because its
  // 10:30 AM end_time crosses this.
  const collidingClassId = await createClass({
    day: 'monday', hourPosition: 2, className: 'Pottery (Hour 2)', room: 'Shared Room', startTime: '10:00 AM',
  });
  const longClassId = await createClass({
    day: 'monday', hourPosition: 1, className: 'Long Span Class', room: 'Shared Room', startTime: '9:00 AM', endTime: '10:30 AM',
  });

  await t.test('both classes still appear in the room grid, each in their own cell', async () => {
    const grid = await roomGridForDay('monday');
    const sharedRow = grid.rows.find((r) => r.room === 'Shared Room');
    assert.ok(sharedRow, 'expected a Shared Room row');

    const longCell = sharedRow.cells.find((c) => c.classes.some((cls) => cls.id === longClassId));
    assert.ok(longCell, 'expected a cell containing the long class');
    assert.equal(longCell.span, 1, 'should NOT span into hour 2 - that column already has a different class in this same room');

    const collidingCell = sharedRow.cells.find((c) => c.classes.some((cls) => cls.id === collidingClassId));
    assert.ok(collidingCell, 'the class created in hour 2 should still have its own cell, not be swallowed by the long class\'s span');
    assert.equal(collidingCell.classes[0].id, collidingClassId);
  });

  await t.test('the colliding class is editable - its own Manage page renders', async () => {
    const admin = await loginAsAdmin();
    const res = await request(app).get(`/admin/class-schedule/classes/${collidingClassId}/manage`).set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Pottery \(Hour 2\)/);
  });

  await t.test('the colliding class also shows up in the List view', async () => {
    const admin = await loginAsAdmin();
    const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Pottery \(Hour 2\)/);
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

// A real bug report: "Class schedule grid shrink text to fit class title
// words on the same row, don't split words. Make sure row titles shrink
// to fit in box." Both the class card's own title and each row's room
// name try to shrink their own font-size down to stay on ONE line, the
// common case at normal/tablet/desktop card widths - a confirmed
// follow-up established that on the narrowest mobile cards, where even a
// realistic title can run out of width before it runs out of readable
// font size, wrapping to a 2nd line at a word boundary (never splitting
// a word) beats clipping the end of the title. Covers: the markup wraps
// both pieces of text in their own shrinkable element with a native-
// tooltip fallback, the CSS never allows mid-word breaking in either the
// single-line or the 2-line-wrap-fallback state, and the script
// implements both the single-line shrink attempt (scrollWidth) and the
// 2-line wrap-and-shrink fallback (scrollHeight) it falls back to.
test('class titles and room names try to stay on one line via JS shrink, with no mid-word breaking possible in CSS even in the 2-line wrap fallback', async () => {
  const { cookie } = await loginAsAdmin();
  await createClass({ day: 'monday', hourPosition: 1, className: 'Super Duper Extra Long Class Title', room: 'A Fairly Long Room Name' });

  const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<span class="class-schedule-room-name" title="A Fairly Long Room Name">A Fairly Long Room Name<\/span>/, 'room name should be wrapped in its own shrinkable span, with a native-tooltip fallback for the rare clipped case');
  assert.match(res.text, /<h3 title="Super Duper Extra Long Class Title">Super Duper Extra Long Class Title<\/h3>/, 'the full title should still render, unclamped/untruncated in markup, with a native-tooltip fallback too');
  assert.match(res.text, /<script src="\/js\/shrink-title-to-fit\.js">/);

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  const titleRule = /\.class-card-header h3\s*\{([^}]*)\}/.exec(css);
  assert.ok(titleRule, 'expected a .class-card-header h3 rule');
  assert.match(titleRule[1], /white-space:\s*nowrap/, 'single-line is the starting point the script measures from');
  assert.match(titleRule[1], /overflow-wrap:\s*normal/, 'no mid-word breaking, even once the script switches white-space to normal for its 2-line wrap fallback');

  const roomNameRule = /\.class-schedule-room-name\s*\{([^}]*)\}/.exec(css);
  assert.ok(roomNameRule, 'expected a .class-schedule-room-name rule');
  assert.match(roomNameRule[1], /white-space:\s*nowrap/);
  assert.match(roomNameRule[1], /overflow-wrap:\s*normal/);

  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shrink-title-to-fit.js'), 'utf8');
  assert.match(js, /\.class-card-header h3,\s*\.class-schedule-room-name/, 'the shrink script should target both the title and the room name');
  assert.match(js, /scrollWidth/, 'phase 1: measure horizontal overflow to try to fit on one line');
  assert.match(js, /scrollHeight/, 'phase 2 fallback: measure 2-line height overflow once single-line shrinking alone was not enough');
  assert.match(js, /webkitLineClamp/, 'phase 2 fallback uses the same temporary 2-line clamp measurement technique as before');
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

test('Classes grid toolbar offers an Export button next to Print, wired to the existing per-day export.csv route', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/schedule').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<a class="icon-btn" href="\/admin\/class-schedule\/monday\/export\.csv" aria-label="Export CSV" title="Export CSV">/);

  const exportRes = await request(app).get('/admin/class-schedule/monday/export.csv').set('Cookie', cookie);
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers['content-type'], /text\/csv/);
});

// A real user request: "in bulk print we should add printing QR sheets
// to scan for quick links to class check in/out kiosk for teachers.
// should be able to select how many classes are added. portrait view,
// name of each class. evenly spaced and displayed up to 4 class on a
// page" - later refined to "each page should be all of the class qr
// codes for that classroom, that day." Covers the Design/Print "Class
// Check-In QR Codes" panel (routes/admin-design.js) end to end: the
// picker lists every class, and the print route groups selected classes
// into one page per (day, room) - a room can never have more than 4
// classes in a day (one per hour_position) - each with a QR code
// encoding an ABSOLUTE URL to that class's own Class Check-In quick link
// (/kiosk/class-checkin/classes/:id/attendance - the same one every
// class card's own quick link opens).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classcheckin-qr-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classcheckin-qr-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const { createClass } = require('../utils/classSchedule');

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
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Class Check-In QR Codes picker lists every class, with no description text, a Room column, and a Day/Room filter popup', async () => {
  const { cookie } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'QR Picker Class', room: 'Room 1' });

  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Class Check-In QR Codes/);
  assert.match(res.text, new RegExp(`name="classIds" value="${classId}"`));
  assert.match(res.text, /QR Picker Class/);
  assert.doesNotMatch(res.text, /One QR code per selected class/);
  // The Print button now sits in the same top row as Select All/Select
  // None/Filter, not a separate row below the picker list - a real
  // request: "the print button should be moved to the top right of the
  // page with the other buttons."
  assert.match(res.text, /id="classcheckin-qr-filter-btn"[\s\S]*?name-tag-bulk-submit"[\s\S]*?Print/);

  // Filter button + popup (Day/Room selects, Save button) that narrows the
  // class list - a real request: "Class QR code printing filter should be
  // filter by day and room number, remove hour filter."
  assert.match(res.text, /id="classcheckin-qr-filter-btn"/);
  assert.match(res.text, /id="classcheckin-qr-filter-dialog"/);
  assert.match(res.text, /id="classcheckin-qr-filter-day-select"/);
  assert.match(res.text, /id="classcheckin-qr-filter-room-select"/);
  assert.doesNotMatch(res.text, /id="classcheckin-qr-filter-hour-select"/);
  assert.match(res.text, /id="classcheckin-qr-filter-save-btn"/);
  assert.match(res.text, new RegExp(`class="qr-picker-row" data-day="monday" data-room="Room 1"[\\s\\S]*?value="${classId}"`));
  // Room column in the picker table itself, alongside Class/Day/Time.
  assert.match(res.text, /<th>Room<\/th>/);
});

test('printing with no classes selected redirects with an error', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const res = await request(app).post('/admin/design/print-classcheckin-qr').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Select at least one class/);
});

// A real follow-up request: "Each page should be all of the class qr
// codes for that classroom, that day." Pages now group by (day, room)
// rather than just chunking the selection 4-at-a-time - covered directly
// below rather than by the old flat "5 classes -> 2 pages" chunking test,
// which no longer describes how pages are built at all.
test('the print sheet groups classes into one page per (day, room), sorted by hour position', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  // Room A/monday: 4 classes filling every hour slot, seeded out of
  // hour_position order - the page should still read 1, 2, 3, 4.
  const roomAIds = [];
  roomAIds.push(await createClass({ day: 'monday', hourPosition: 3, className: 'Room A Hour 3', room: 'Room A' }));
  roomAIds.push(await createClass({ day: 'monday', hourPosition: 1, className: 'Room A Hour 1', room: 'Room A' }));
  roomAIds.push(await createClass({ day: 'monday', hourPosition: 4, className: 'Room A Hour 4', room: 'Room A' }));
  roomAIds.push(await createClass({ day: 'monday', hourPosition: 2, className: 'Room A Hour 2', room: 'Room A' }));
  // Room B/wednesday: only 1 class - a different day AND a different room
  // than Room A, so it must land on its own separate page.
  const roomBId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Room B Solo Class', room: 'Room B' });

  const classIds = [...roomAIds, roomBId];
  const res = await request(app)
    .post('/admin/design/print-classcheckin-qr')
    .set('Cookie', cookie)
    .type('form')
    .send({ classIds: classIds.map(String), _csrf: csrfToken });
  assert.equal(res.status, 200);

  await t.test('5 classes across 2 (day, room) groups land on exactly 2 pages', async () => {
    const pageCount = (res.text.match(/class="qr-sheet-page"/g) || []).length;
    assert.equal(pageCount, 2, 'one page for Room A/monday, one page for Room B/wednesday');
    const cellCount = (res.text.match(/class="qr-sheet-cell"/g) || []).length;
    assert.equal(cellCount, 5, 'every selected class should get its own cell across both pages');
  });

  await t.test('each page header names its own room and day', async () => {
    assert.match(res.text, /Room A[\s\S]{0,30}Monday/);
    assert.match(res.text, /Room B[\s\S]{0,30}Wednesday/);
  });

  await t.test('Room A\'s page reads Hour 1 through Hour 4 in order, not seed order', async () => {
    const order = ['Room A Hour 1', 'Room A Hour 2', 'Room A Hour 3', 'Room A Hour 4'].map((name) => res.text.indexOf(name));
    assert.ok(order.every((i) => i !== -1), 'all four class names should be present');
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'hour 1-4 should appear in that order on the page');
  });

  await t.test('each cell carries the class name and an absolute Class Check-In URL', async () => {
    for (const classId of classIds) {
      assert.match(res.text, new RegExp(`data-qr-value="http://[^"]*/kiosk/class-checkin/classes/${classId}/attendance"`));
    }
    assert.match(res.text, /Room A Hour 1/);
    assert.match(res.text, /Room B Solo Class/);
  });

  await t.test('the QR rendering script and vendored library are both loaded', async () => {
    assert.match(res.text, /<script src="\/js\/vendor\/qrcode\.min\.js"><\/script>/);
    assert.match(res.text, /<script src="\/js\/classcheckin-qr-print\.js"><\/script>/);
  });

  // A real bug report: "The print preview shows 4 nice class cards on one
  // page ... When you go to the printer it is on two pages." Root cause:
  // @page's own non-zero margin, stacked on top of .qr-sheet-page's own
  // identical-sized 8.5in x 11in box (with its own padding as the visual
  // margin), shrank the printable area enough that the bottom of the page
  // had nowhere to go but a second physical page - see styles.css's
  // .qr-sheet-page comment for the full explanation. margin: 0 here is
  // what makes the div's box exactly match the physical page again.
  await t.test('@page has no margin of its own - only .qr-sheet-page\'s own padding provides one', async () => {
    assert.match(res.text, /@page\s*\{\s*size:\s*letter portrait;\s*margin:\s*0;\s*\}/);
  });
});

// A real user request: "can we add a class quick link to every class?" -
// clarified to mean a link straight into the Class Check-In kiosk's own
// attendance sheet for that specific class (/kiosk/class-checkin/classes/
// :id/attendance - Check In and Check Out both live there, see routes/
// kiosk-class-checkin.js), so a teacher/sub doesn't have to click through
// the kiosk's own day-picker/hour-search to reach their one class.
//
// A later real request: "remove the edit button and attendance link
// button from the schedule cards to view the titles easier. the
// attendance link should be on the edit class form" moved this link OFF
// the Schedules grid's own class card entirely - the card itself is now
// the whole-card click target for the View modal (views/partials/
// class-schedule-grid.ejs's own data-view-class, public/js/class-schedule-
// view.js), not a dedicated button - and the quick link only lives inside
// that View modal (views/class-schedule-view-fragment.ejs) now. The ?next=
// round-trip through the PIN gate itself is covered in
// test/routes-kiosk-class-checkin.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-checkin-quicklink-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-checkin-quicklink-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('every class card on the Schedules grid is a whole-card click target into its own View modal (no inline quick link anymore)', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Quick Link Class', room: 'Room 1' });

  // /admin/class-schedule/:day is a compatibility redirect straight to
  // the real tabbed page (see routes/admin-class-schedule.js's own
  // comment on why) - the grid itself only ever renders at /admin/
  // schedule?tab=:day.
  const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(
    res.text,
    new RegExp(`href="/kiosk/class-checkin/classes/${classId}/attendance"`),
    'the grid card itself no longer links straight to the kiosk attendance sheet - that link moved into the View modal'
  );
  assert.match(
    res.text,
    new RegExp(`data-view-class="${classId}"`),
    'the whole card should be the click target that opens the View modal, where the quick link now lives'
  );
});

test('the class View modal offers the same quick link alongside Export/Print', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Quick Link View Class', room: 'Room 2' });

  const res = await request(app).get(`/admin/class-schedule/classes/${classId}/view-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`href="/kiosk/class-checkin/classes/${classId}/attendance"[^>]*target="_blank"`));
  assert.match(res.text, /Class Check-In Link/);
});

test('neither the old dedicated View button nor the old dedicated quick-link button render on the grid anymore', async () => {
  const cookie = await loginAsAdmin();
  await createClass({ day: 'wednesday', hourPosition: 1, className: 'Guard Check Class', room: 'Room 3' });

  const res = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  assert.doesNotMatch(res.text, /class-card-view-btn/, 'the dedicated Edit/View button was removed - the whole card is the click target now');
  assert.doesNotMatch(res.text, /class-card-quicklink-btn/, 'the dedicated quick-link button was removed - the attendance link now lives on the View modal instead');
});

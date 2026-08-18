// A real user request: "can we add a class quick link to every class?" -
// clarified to mean a link straight into the Class Check-In kiosk's own
// attendance sheet for that specific class (/kiosk/class-checkin/classes/
// :id/attendance - Check In and Check Out both live there, see routes/
// kiosk-class-checkin.js), so a teacher/sub doesn't have to click through
// the kiosk's own day-picker/hour-search to reach their one class. This
// file covers the two places that link is offered: the Schedules page's
// class card (views/partials/class-schedule-grid.ejs) and its View modal
// (views/class-schedule-view-fragment.ejs). The ?next= round-trip through
// the PIN gate itself is covered in test/routes-kiosk-class-checkin.test.js.
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

test('every class card on the Schedules grid carries its own Class Check-In quick link', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Quick Link Class', room: 'Room 1' });

  // /admin/class-schedule/:day is a compatibility redirect straight to
  // the real tabbed page (see routes/admin-class-schedule.js's own
  // comment on why) - the grid itself only ever renders at /admin/
  // schedule?tab=:day.
  const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    new RegExp(`href="/kiosk/class-checkin/classes/${classId}/attendance"[^>]*target="_blank"`),
    'the class card should link straight to that class\'s own kiosk attendance sheet, opened in a new tab'
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

test('the quick link and the View button share the same visibility guard on the grid (both or neither)', async () => {
  const cookie = await loginAsAdmin();
  await createClass({ day: 'wednesday', hourPosition: 1, className: 'Guard Check Class', room: 'Room 3' });

  const res = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  const viewBtnCount = (res.text.match(/class-card-view-btn/g) || []).length;
  const quickLinkCount = (res.text.match(/class-card-quicklink-btn/g) || []).length;
  assert.ok(viewBtnCount > 0, 'sanity check: at least one View button rendered');
  assert.equal(quickLinkCount, viewBtnCount, 'the quick link and View button should appear the same number of times - same visibility guard');
});

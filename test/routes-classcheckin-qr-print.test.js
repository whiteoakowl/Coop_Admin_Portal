// A real user request: "in bulk print we should add printing QR sheets
// to scan for quick links to class check in/out kiosk for teachers.
// should be able to select how many classes are added. portrait view,
// name of each class. evenly spaced and displayed up to 4 class on a
// page." Covers the new Design/Print "Class Check-In QR Codes" panel
// (routes/admin-design.js) end to end: the picker lists every class, and
// the print route paginates selected classes 4-per-page, each with a QR
// code encoding an ABSOLUTE URL to that class's own Class Check-In quick
// link (/kiosk/class-checkin/classes/:id/attendance - the same one every
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

test('Class Check-In QR Codes picker lists every class, with no description text and a Day/Hour filter popup', async () => {
  const { cookie } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'QR Picker Class', room: 'Room 1' });

  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Class Check-In QR Codes/);
  assert.match(res.text, new RegExp(`name="classIds" value="${classId}"`));
  assert.match(res.text, /QR Picker Class/);
  assert.doesNotMatch(res.text, /One QR code per selected class/);

  // Filter button + popup (Day/Hour selects, Save button) that narrows the
  // class list - a real request: "add a filter button. when clicking the
  // filter button you get a popup window to select day and hour ... this
  // narrow the list of class choices to choose from."
  assert.match(res.text, /id="classcheckin-qr-filter-btn"/);
  assert.match(res.text, /id="classcheckin-qr-filter-dialog"/);
  assert.match(res.text, /id="classcheckin-qr-filter-day-select"/);
  assert.match(res.text, /id="classcheckin-qr-filter-hour-select"/);
  assert.match(res.text, /id="classcheckin-qr-filter-save-btn"/);
  assert.match(res.text, new RegExp(`class="qr-picker-row" data-day="monday" data-hour="1"[\\s\\S]*?value="${classId}"`));
});

test('printing with no classes selected redirects with an error', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const res = await request(app).post('/admin/design/print-classcheckin-qr').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Select at least one class/);
});

test('the print sheet paginates 4 classes per page, each with an absolute QR link and class name', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classIds = [];
  for (let i = 0; i < 5; i++) {
    classIds.push(await createClass({ day: 'monday', hourPosition: (i % 4) + 1, className: `Sheet Class ${i}`, room: `Room ${i}` }));
  }

  const res = await request(app)
    .post('/admin/design/print-classcheckin-qr')
    .set('Cookie', cookie)
    .type('form')
    .send({ classIds: classIds.map(String), _csrf: csrfToken });
  assert.equal(res.status, 200);

  await t.test('5 selected classes land on 2 pages (4 + 1), not one long page', async () => {
    const pageCount = (res.text.match(/class="qr-sheet-page"/g) || []).length;
    assert.equal(pageCount, 2, '5 classes at 4-per-page should produce 2 pages');
    const cellCount = (res.text.match(/class="qr-sheet-cell"/g) || []).length;
    assert.equal(cellCount, 5, 'every selected class should get its own cell across both pages');
  });

  await t.test('each cell carries the class name and an absolute Class Check-In URL', async () => {
    for (const classId of classIds) {
      assert.match(res.text, new RegExp(`data-qr-value="http://[^"]*/kiosk/class-checkin/classes/${classId}/attendance"`));
    }
    assert.match(res.text, /Sheet Class 0/);
    assert.match(res.text, /Sheet Class 4/);
  });

  await t.test('the QR rendering script and vendored library are both loaded', async () => {
    assert.match(res.text, /<script src="\/js\/vendor\/qrcode\.min\.js"><\/script>/);
    assert.match(res.text, /<script src="\/js\/classcheckin-qr-print\.js"><\/script>/);
  });
});

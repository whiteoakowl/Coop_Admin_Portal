// A real request: "All print button should show a print preview full
// real page on a page with a print button. That print button will then
// send it to the printer." Covers the Floater Assignments manage page's
// own Print button (views/admin-volunteers.ejs): it now links to a
// dedicated preview page (routes/admin-volunteers.js's own GET
// /volunteers/:day/manage/print) instead of calling window.print() on
// the live, editable page, same convention as every other print button
// site-wide.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-manage-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-manage-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { classVacancySlotId } = require('../utils/substitutes');

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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - buffers the binary response so the
// PDF bytes can actually be checked, the same way test/parent-family-
// school-print-preview-and-pdf.test.js does for its own download.pdf
// routes.
async function getBuffer(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

test('Floater Assignments manage page: Print button links to a dedicated preview page instead of calling window.print() directly', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const date = nextMonday();

  const before = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(before.text);
  await request(app).post(`/admin/volunteers/${day}/dates/add?dialog=dates`).set('Cookie', cookie).type('form').send({ dates: date, _csrf: csrfToken });

  const manage = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, new RegExp(`href="/admin/volunteers/${day}/manage/print\\?date=${date}&semesterId=[^"]*" target="_blank"`), 'Print button should link to the preview page, carrying the same selected date');
  assert.doesNotMatch(manage.text, /icon-btn" onclick="window\.print\(\)" aria-label="Print"/, 'the old direct-to-print-dialog button should be gone');
  assert.match(manage.text, new RegExp(`href="/admin/volunteers/${day}/manage/download\\.pdf\\?date=${date}&semesterId=[^"]*" aria-label="Download PDF"`), 'Download PDF button should sit next to Print');
});

// A real request: "the download should be a pdf of exactly how it
// would also look when printing" - same selected-date chart the print
// preview shows, as a real PDF from routes/admin-volunteers.js's own
// GET /volunteers/:day/manage/download.pdf.
test('Floater Assignments manage page: Download PDF is a real PDF of the same selected-date chart the print preview shows', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 2, className: 'Download PDF Class', room: 'Room 9', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Download PDF Floater', 'download-pdf-floater-1', 'parent')")
    .run();
  const date = nextMonday();
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app).post(`/admin/volunteers/${day}/dates/add?dialog=dates`).set('Cookie', cookie).type('form').send({ dates: date, _csrf: csrfToken });
  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  const pdfRes = await getBuffer(`/admin/volunteers/${day}/manage/download.pdf?date=${date}`, cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="monday-floater-assignments\.pdf"/);
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('Floater Assignments manage download.pdf requires admin login, same as the manage page it mirrors', async () => {
  const res = await request(app).get('/admin/volunteers/monday/manage/download.pdf');
  assert.equal(res.status, 302, 'unauthenticated request should redirect to login');
});

test('Floater Assignments manage print preview: shows the same selected-date chart, read-only, with its own Print button', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 2, className: 'Print Preview Class', room: 'Room 7', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Floater', 'print-preview-floater-1', 'parent')")
    .run();
  const date = nextMonday();
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app).post(`/admin/volunteers/${day}/dates/add?dialog=dates`).set('Cookie', cookie).type('form').send({ dates: date, _csrf: csrfToken });
  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  const preview = await request(app).get(`/admin/volunteers/${day}/manage/print?date=${date}`).set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /class="print-preview-header no-print"/, 'the preview page should have its own no-print header');
  assert.match(preview.text, /roster-action-btn print-action-btn" onclick="window\.print\(\)"/, 'the preview page itself should have the real Print button');
  assert.match(preview.text, /Print Preview Class/, 'should show the specific class the vacancy belongs to');
  assert.match(preview.text, /Room 7/);
  assert.match(preview.text, /Print Preview Floater/, 'should show who is actually assigned, not an editable dropdown');
  assert.doesNotMatch(preview.text, /<select/, 'read-only preview should have no editable assign dropdown');

  // A real request: "each hour should shrink to fit on one page" - the
  // old page-break-only wrapper is gone, replaced by the same shrink-
  // to-fit wrapper/script Setup/Cleanup Teams printing already uses.
  assert.match(preview.text, /<div class="floater-print-page-fit" data-shrink-to-fit-on-print data-shrink-to-fit-budget="9\.2in">/);
  assert.match(preview.text, /<div class="floater-print-page-inner">/);
  assert.match(preview.text, /class="admin-page floater-assignments-print-page team-print-preview-page"/);
  assert.match(preview.text, /<script src="\/js\/print-shrink-to-fit\.js"><\/script>/);
});

test('Floater Assignments manage print preview requires admin login, same as the manage page it mirrors', async () => {
  const res = await request(app).get('/admin/volunteers/monday/manage/print');
  assert.equal(res.status, 302, 'unauthenticated request should redirect to login');
});

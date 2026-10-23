// Coverage for a real request: "Main admin portal, add a tab called
// annual calendar. This calendar will work similar to the family school
// management attendance calendar where you can click on the dates to
// change the color... Dropdown menu for each fiscal year created in the
// system. Can create a calendar for each fiscal year. Create key
// button. Be able to add a label and color for each key item. Key shows
// on page. Be able to click each key then click on the calendar dates to
// color/key each one that particular key... This will also be a quick
// links on parent portal and in admin settings gear."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-annual-calendar-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-annual-calendar-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/annual-calendar').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createFiscalYear(startDate, endDate) {
  return (await db.prepare('INSERT INTO fiscal_years (start_date, end_date) VALUES (?, ?) RETURNING *').get(startDate, endDate));
}

test('With no fiscal years yet, the page points to Accounting instead of a broken dropdown', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/annual-calendar').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /No fiscal years yet/);
  assert.match(page.text, /href="\/main-admin\/accounting\/categories"/);
});

test('Create Calendar for a fiscal year, then add keys and click dates to color them', async () => {
  const fy = await createFiscalYear('2026-09-20', '2027-06-15');
  const admin = await loginAsMainAdmin();

  const page = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /\+ Create Calendar for 9\/20\/2026 - 6\/15\/2027/);

  const createRes = await request(app)
    .post('/main-admin/annual-calendar/create')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fiscalYearId: String(fy.id), _csrf: extractCsrf(page.text) });
  assert.match(createRes.headers.location, new RegExp(`fiscalYearId=${fy.id}`));

  const calendar = await db.prepare('SELECT * FROM annual_calendars WHERE fiscal_year_id = ?').get(fy.id);
  assert.ok(calendar, 'a calendar row should exist for this fiscal year');

  // "Create key button. Be able to add a label and color for each key
  // item. Key shows on page."
  const afterCreate = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  // 12 consecutive months starting at the fiscal year's own start month
  // (September 2026 here) - "the full 12 month calendar."
  assert.match(afterCreate.text, /September 2026/);
  assert.match(afterCreate.text, /August 2027/);
  assert.doesNotMatch(afterCreate.text, /July 2026/, 'should not include a month before the fiscal year starts');

  await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), fiscalYearId: String(fy.id), label: 'Holiday', color: '#ff0000', _csrf: extractCsrf(afterCreate.text) });
  const key = await db.prepare("SELECT * FROM annual_calendar_keys WHERE label = 'Holiday'").get();
  assert.ok(key, 'the key should be saved');
  assert.equal(key.color, '#ff0000');

  const withKey = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  assert.match(withKey.text, /Holiday/, 'the key should show on the page');

  // "Be able to click each key then click on the calendar dates to
  // color/key each one that particular key." - the AJAX toggle endpoint
  // public/js/annual-calendar.js's own click handler posts to.
  const toggleRes = await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: '2026-09-25', keyId: String(key.id), _csrf: extractCsrf(withKey.text) });
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleRes.body.ok, true);
  assert.equal(toggleRes.body.key.label, 'Holiday');

  const dayRow = await db.prepare('SELECT * FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, '2026-09-25');
  assert.equal(dayRow.key_id, key.id);

  const coloredPage = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  assert.match(coloredPage.text, /data-date="2026-09-25"[^>]*style="background-color: #ff0000;"/);

  // Clicking the SAME key on an already-keyed date clears it back to
  // unmarked - the same click-to-toggle shape Family Attendance uses.
  const clearRes = await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: '2026-09-25', keyId: String(key.id), _csrf: extractCsrf(coloredPage.text) });
  assert.equal(clearRes.body.key, null);
  assert.equal(await db.prepare('SELECT 1 FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, '2026-09-25'), undefined);
});

test('Deleting a key clears any date colored with it instead of leaving a dangling reference', async () => {
  const fy = await createFiscalYear('2027-01-01', '2027-12-31');
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/annual-calendar/create').set('Cookie', admin.cookie).type('form').send({ fiscalYearId: String(fy.id), _csrf: admin.csrfToken });
  const calendar = await db.prepare('SELECT * FROM annual_calendars WHERE fiscal_year_id = ?').get(fy.id);

  const page = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), fiscalYearId: String(fy.id), label: 'Field Trip', color: '#00ff00', _csrf: extractCsrf(page.text) });
  const key = await db.prepare("SELECT * FROM annual_calendar_keys WHERE label = 'Field Trip'").get();

  const pageWithKey = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: '2027-03-10', keyId: String(key.id), _csrf: extractCsrf(pageWithKey.text) });

  const pageBeforeDelete = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/annual-calendar/keys/${key.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fiscalYearId: String(fy.id), _csrf: extractCsrf(pageBeforeDelete.text) });

  assert.equal(await db.prepare('SELECT 1 FROM annual_calendar_keys WHERE id = ?').get(key.id), undefined);
  const dayRow = await db.prepare('SELECT * FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, '2027-03-10');
  assert.equal(dayRow.key_id, null, 'the date keeps its own row but with no key - the delete-set-null cascade');
});

test('Print preview and Download PDF show the 12-month grid and the key legend', async () => {
  const fy = await createFiscalYear('2026-01-01', '2026-12-31');
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/annual-calendar/create').set('Cookie', admin.cookie).type('form').send({ fiscalYearId: String(fy.id), _csrf: admin.csrfToken });
  const calendar = await db.prepare('SELECT * FROM annual_calendars WHERE fiscal_year_id = ?').get(fy.id);
  const page = await request(app).get(`/main-admin/annual-calendar?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), fiscalYearId: String(fy.id), label: 'Break', color: '#0000ff', _csrf: extractCsrf(page.text) });

  const previewRes = await request(app).get(`/main-admin/annual-calendar/print?fiscalYearId=${fy.id}`).set('Cookie', admin.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /class="print-preview-header no-print"/);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.equal((previewRes.text.match(/class="fs-attendance-print-month"/g) || []).length, 12, 'exactly 12 month grids - one page');
  assert.match(previewRes.text, /Break/);

  const pdfRes = await request(app)
    .get(`/main-admin/annual-calendar/download.pdf?fiscalYearId=${fy.id}`)
    .set('Cookie', admin.cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});

test('Annual Calendar requires Main Admin login', async () => {
  const res = await request(app).get('/main-admin/annual-calendar');
  assert.equal(res.status, 302, 'unauthenticated request should redirect to login');
});

test('Main Admin Quick Links includes Annual Calendar', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/quick-links').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/main-admin\/annual-calendar" target="_blank">Annual Calendar<\/a>/);
});

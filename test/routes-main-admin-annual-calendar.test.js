// Coverage for a real request: "Main admin portal, add a tab called
// annual calendar. This calendar will work similar to the family school
// management attendance calendar where you can click on the dates to
// change the color... Dropdown menu for each fiscal year created in the
// system. Can create a calendar for each fiscal year. Create key
// button. Be able to add a label and color for each key item. Key shows
// on page. Be able to click each key then click on the calendar dates to
// color/key each one that particular key... This will also be a quick
// links on parent portal and in admin settings gear."
//
// A later real request replaced the fiscal-year dropdown with a plain
// generated school-year list ("2026-2027, 2027-2028, 2028-2029 etc.
// create the next 20 years and 6 years before") that auto-creates its
// own calendar behind the scenes - no more manual "+ Create Calendar"
// step. See routes/main-admin-annual-calendar.js and utils/
// annualCalendar.js's own schoolYearStartYears/
// findOrCreateFiscalYearForSchoolYear for the real current behavior
// this file now exercises.
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
const { currentSchoolYearStartYear } = require('../utils/annualCalendar');

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

// A distinct school year per test (an offset from "today's" own current
// school year) so each test's calendar/keys never collide with another
// test's, the same reasoning the old per-test fiscal year date ranges
// served - but generated relative to today instead of hardcoded, so
// this keeps working no matter when it's actually run (the dropdown
// only ever covers 6 years before today's school year to 20 after).
let yearOffset = 1;
function nextStartYear() {
  yearOffset += 1;
  return currentSchoolYearStartYear() + yearOffset;
}

async function openCalendar(admin, startYear) {
  const page = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  const calendar = await db.prepare('SELECT * FROM annual_calendars WHERE fiscal_year_id = (SELECT id FROM fiscal_years WHERE start_date = ?)').get(`${startYear}-08-01`);
  return { page, calendar };
}

test('Picking a school year transparently creates its own calendar - no separate "+ Create Calendar" step', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();

  const { page, calendar } = await openCalendar(admin, startYear);
  assert.equal(page.status, 200);
  assert.ok(calendar, 'a calendar row should already exist on first visit - no create step needed');
  assert.doesNotMatch(page.text, /Create Calendar/);
  assert.match(page.text, new RegExp(`<option value="${startYear}" selected>${startYear}-${startYear + 1}</option>`));

  // "Mobile and desktop view should show the full 12 month calendar" -
  // a generated school year always starts in August (utils/
  // annualCalendar.js's own findOrCreateFiscalYearForSchoolYear).
  assert.match(page.text, new RegExp(`August ${startYear}`));
  assert.match(page.text, new RegExp(`July ${startYear + 1}`));
  assert.doesNotMatch(page.text, new RegExp(`June ${startYear}`), 'should not include a month before the school year starts');
});

test('Create key button, add/edit/delete keys, and click dates to color them', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { page, calendar } = await openCalendar(admin, startYear);

  // "Create key button. Be able to add a label and color for each key
  // item. Key shows on page." public/js/annual-calendar-keys.js's own
  // Add Key form posts JSON back instead of redirecting, so it can
  // append the new row without a page reload.
  const addKeyRes = await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), label: 'Holiday', color: '#ff0000', _csrf: extractCsrf(page.text) });
  assert.equal(addKeyRes.status, 200);
  assert.equal(addKeyRes.body.ok, true);
  assert.equal(addKeyRes.body.key.label, 'Holiday');
  assert.equal(addKeyRes.body.key.color, '#ff0000');
  const key = await db.prepare("SELECT * FROM annual_calendar_keys WHERE label = 'Holiday'").get();
  assert.ok(key, 'the key should be saved');
  assert.equal(key.color, '#ff0000');

  const withKey = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  assert.match(withKey.text, /Holiday/, 'the key should show on the page');
  // "Create key button should say add/edit key... Delete description."
  assert.match(withKey.text, />Add\/Edit Key</);
  assert.doesNotMatch(withKey.text, /\+ Create Key/);
  // "Edit calendar colors button and add/edit key button should be on
  // the same row side by side."
  assert.match(withKey.text, /annual-calendar-key-actions-row/);
  // "Pop up to add/edit key add a trash button next to each key
  // created. Also a save changes button at the bottom."
  assert.match(withKey.text, /data-delete-key/);
  assert.match(withKey.text, /id="annual-calendar-save-keys-btn"/);

  // "Be able to click each key then click on the calendar dates to
  // color/key each one that particular key." - the AJAX toggle endpoint
  // public/js/annual-calendar.js's own click handler posts to.
  const toggleDate = `${startYear}-09-25`;
  const toggleRes = await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: toggleDate, keyId: String(key.id), _csrf: extractCsrf(withKey.text) });
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleRes.body.ok, true);
  assert.equal(toggleRes.body.key.label, 'Holiday');

  const dayRow = await db.prepare('SELECT * FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, toggleDate);
  assert.equal(dayRow.key_id, key.id);

  const coloredPage = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  assert.match(coloredPage.text, new RegExp(`data-date="${toggleDate}"[^>]*style="background-color: #ff0000;"`));

  // Clicking the SAME key on an already-keyed date clears it back to
  // unmarked - the same click-to-toggle shape Family Attendance uses.
  const clearRes = await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: toggleDate, keyId: String(key.id), _csrf: extractCsrf(coloredPage.text) });
  assert.equal(clearRes.body.key, null);
  assert.equal(await db.prepare('SELECT 1 FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, toggleDate), undefined);
});

test('Deleting a key clears any date colored with it instead of leaving a dangling reference', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { page, calendar } = await openCalendar(admin, startYear);

  await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), label: 'Field Trip', color: '#00ff00', _csrf: extractCsrf(page.text) });
  const key = await db.prepare("SELECT * FROM annual_calendar_keys WHERE label = 'Field Trip'").get();

  const pageWithKey = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  const toggleDate = `${startYear}-10-10`;
  await request(app)
    .post('/main-admin/annual-calendar/days/toggle')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), date: toggleDate, keyId: String(key.id), _csrf: extractCsrf(pageWithKey.text) });

  const pageBeforeDelete = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  const deleteRes = await request(app)
    .post(`/main-admin/annual-calendar/keys/${key.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: extractCsrf(pageBeforeDelete.text) });
  // AJAX now (public/js/annual-calendar-keys.js removes the row itself
  // on a 200) instead of redirecting back to the page.
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.ok, true);

  assert.equal(await db.prepare('SELECT 1 FROM annual_calendar_keys WHERE id = ?').get(key.id), undefined);
  const dayRow = await db.prepare('SELECT * FROM annual_calendar_days WHERE calendar_id = ? AND day_date = ?').get(calendar.id, toggleDate);
  assert.equal(dayRow.key_id, null, 'the date keeps its own row but with no key - the delete-set-null cascade');
});

test('Save Changes (bulk-update) saves every key row\'s label/color in one request', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { page, calendar } = await openCalendar(admin, startYear);
  const csrf = extractCsrf(page.text);

  const keyA = (
    await request(app)
      .post('/main-admin/annual-calendar/keys')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ calendarId: String(calendar.id), label: 'Holiday', color: '#ff0000', _csrf: csrf })
  ).body.key;
  const keyB = (
    await request(app)
      .post('/main-admin/annual-calendar/keys')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ calendarId: String(calendar.id), label: 'Break', color: '#00ff00', _csrf: csrf })
  ).body.key;

  // "Be able to edit existing keys and click save changes." - both
  // rows' label/color are sent together in one bulk-update request.
  const bulkRes = await request(app)
    .post('/main-admin/annual-calendar/keys/bulk-update')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', csrf)
    .send({ keys: [{ id: keyA.id, label: 'Holiday Renamed', color: '#111111' }, { id: keyB.id, label: 'Break', color: '#00ff00' }] });
  assert.equal(bulkRes.status, 200);
  assert.equal(bulkRes.body.ok, true);

  const savedA = await db.prepare('SELECT * FROM annual_calendar_keys WHERE id = ?').get(keyA.id);
  assert.equal(savedA.label, 'Holiday Renamed');
  assert.equal(savedA.color, '#111111');
  const savedB = await db.prepare('SELECT * FROM annual_calendar_keys WHERE id = ?').get(keyB.id);
  assert.equal(savedB.label, 'Break');
});

test('Edit Calendar Colors: button opens a dialog, saves month/weekday row colors, and the live grid picks them up', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { page, calendar } = await openCalendar(admin, startYear);

  assert.match(page.text, />Edit Calendar Colors</);
  assert.match(page.text, /id="annual-calendar-colors-dialog"/);
  // Nothing picked yet - no inline custom properties on the grid.
  assert.doesNotMatch(page.text, /--annual-calendar-month-color/);

  const colorsRes = await request(app)
    .post('/main-admin/annual-calendar/colors')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), monthRowColor: '#112233', weekdayRowColor: '#445566', _csrf: extractCsrf(page.text) });
  assert.equal(colorsRes.status, 200);
  assert.equal(colorsRes.body.ok, true);

  const saved = await db.prepare('SELECT * FROM annual_calendars WHERE id = ?').get(calendar.id);
  assert.equal(saved.month_row_color, '#112233');
  assert.equal(saved.weekday_row_color, '#445566');

  const afterSave = await request(app).get(`/main-admin/annual-calendar?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  assert.match(afterSave.text, /--annual-calendar-month-color: #112233;/);
  assert.match(afterSave.text, /--annual-calendar-weekday-color: #445566;/);

  const printRes = await request(app).get(`/main-admin/annual-calendar/print?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  assert.match(printRes.text, /--annual-calendar-month-color: #112233;/);
  assert.match(printRes.text, /--annual-calendar-weekday-color: #445566;/);
});

test('Edit Calendar Colors rejects a non-hex color', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { calendar } = await openCalendar(admin, startYear);

  const res = await request(app)
    .post('/main-admin/annual-calendar/colors')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), monthRowColor: 'javascript:alert(1)', weekdayRowColor: '#445566', _csrf: admin.csrfToken });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);

  const saved = await db.prepare('SELECT * FROM annual_calendars WHERE id = ?').get(calendar.id);
  assert.equal(saved.month_row_color, null, 'the bad value should never reach the database');
});

test('Print preview and Download PDF show the 12-month grid, a centered title, and the key legend', async () => {
  const startYear = nextStartYear();
  const admin = await loginAsMainAdmin();
  const { page, calendar } = await openCalendar(admin, startYear);
  await request(app)
    .post('/main-admin/annual-calendar/keys')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ calendarId: String(calendar.id), label: 'Break', color: '#0000ff', _csrf: extractCsrf(page.text) });

  const previewRes = await request(app).get(`/main-admin/annual-calendar/print?schoolYear=${startYear}`).set('Cookie', admin.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /class="print-preview-header no-print"/);
  assert.match(previewRes.text, /onclick="window\.print\(\)"/);
  assert.equal((previewRes.text.match(/class="annual-calendar-print-month"/g) || []).length, 12, 'exactly 12 month grids - one page, 3 columns x 4 rows');
  // "Title should be 2026-2027 Annual Calendar and centered."
  assert.match(previewRes.text, new RegExp(`<h2 class="annual-calendar-print-title">${startYear}-${startYear + 1} Annual Calendar</h2>`));
  assert.match(previewRes.text, /Break/);
  // A real request: "Print and pdf should have the calendars in
  // portrait view" - explicit "portrait" keyword, not just implied by
  // "letter" alone.
  assert.match(previewRes.text, /@page \{ size: letter portrait; margin: 0\.5in; \}/);

  const pdfRes = await request(app)
    .get(`/main-admin/annual-calendar/download.pdf?schoolYear=${startYear}`)
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

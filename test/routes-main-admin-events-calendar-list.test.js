// Coverage for Main Admin Events layout/form polish (item 18) - a real
// request: "prev/next buttons should be side by side with the month name
// stacked above them, add a list/calendar view toggle button, and the
// create event form needs a lot more detail fields." Route-level checks
// only (markup/query wiring); the underlying create/publish/builder flow
// is already covered by test/routes-events.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-calendar-list-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-calendar-list-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

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
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall Picnic', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const match = /\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location);
  return Number(match[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

test('Calendar tab: toggle row sits above a single Prev/month-select/year-select/Next row', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=calendar').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /event-calendar-month-label/, 'the standalone month-name label was dropped - the month/year dropdowns already show it');
  const toolbarStart = page.text.indexOf('<div class="event-calendar-toolbar no-print">');
  assert.ok(toolbarStart >= 0, 'expected the calendar toolbar to be present');
  const toolbarEnd = page.text.indexOf('</table>', toolbarStart);
  const toolbarHtml = page.text.slice(toolbarStart, toolbarEnd);
  const toggleIndex = toolbarHtml.indexOf('event-calendar-view-row');
  const navIndex = toolbarHtml.indexOf('event-calendar-nav-row');
  assert.ok(toggleIndex >= 0 && navIndex >= 0 && toggleIndex < navIndex, 'the Calendar/List toggle row should render above the Prev/month/year/Next row');
  assert.match(toolbarHtml, /&larr; Prev/);
  assert.match(toolbarHtml, /Next &rarr;/);
  assert.match(toolbarHtml, /id="event-month-select"/);
  assert.match(toolbarHtml, /id="event-year-select"/);
});

test('Calendar tab: List/Calendar view toggle switches rendering and preserves the month in the URL', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { location: 'Fellowship Hall' });
  await publishEvent(admin, eventId);

  const calendarPage = await request(app).get('/main-admin/events?tab=calendar&month=2027-09').set('Cookie', admin.cookie);
  assert.match(calendarPage.text, /class="roster-action-btn archived-toggle-btn icon-toggle-btn active" href="\/main-admin\/events\?tab=calendar&view=calendar&month=2027-09" aria-label="Calendar View"/);
  assert.match(calendarPage.text, /event-calendar-table/);
  assert.doesNotMatch(calendarPage.text, /<th>Location<\/th>/);

  const listPage = await request(app).get('/main-admin/events?tab=calendar&view=list&month=2027-09').set('Cookie', admin.cookie);
  assert.equal(listPage.status, 200);
  assert.match(listPage.text, /class="roster-action-btn archived-toggle-btn icon-toggle-btn active" href="\/main-admin\/events\?tab=calendar&view=list&month=2027-09" aria-label="List View"/);
  assert.match(listPage.text, /Fall Picnic/);
  assert.match(listPage.text, /Fellowship Hall/);
  assert.match(listPage.text, /<th>Location<\/th>/);
});

test('New Event wizard: many more detail fields beyond Title/Starts, and creating with them saves correctly', async () => {
  // The quick-create popup this test originally covered was replaced by
  // a full multi-step wizard at its own /main-admin/events/new route (a
  // real request: "creating events should look just like this image" -
  // see views/admin-events-new.ejs) - same fields, just on their own
  // page instead of a dialog over the calendar tab.
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.match(page.text, /name="description"/);
  assert.match(page.text, /name="locationId"/);
  assert.match(page.text, /name="endsAt"/);
  assert.match(page.text, /name="categoryId"/);
  assert.match(page.text, /name="visibility"/);
  assert.match(page.text, /name="capacity"/);

  const eventId = await createEvent(admin, {
    description: 'Bring a dish to share.',
    location: 'North Field',
    endsAt: '2027-09-01T20:00',
    visibility: 'public',
    capacity: '50',
  });
  const builder = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builder.text, /North Field/);
  assert.match(builder.text, /Bring a dish to share\./);
  assert.match(builder.text, /value="50"/);
  assert.match(builder.text, /<option value="public" selected>Public<\/option>/);
});

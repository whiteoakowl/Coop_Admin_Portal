// A real request: "Calendar event view, passed events shouldn't
// disappear. They should always remain on the calendar. In list view
// passed events should be move to the bottom under past events." The
// shared member-facing /events page (routes/events.js) used to fetch
// upcomingOnly: true, so a published event vanished from BOTH views
// entirely the instant its own start time passed - fine for a simple
// upcoming-only list, but wrong for Calendar view (a past month showed
// nothing) and wrong for List view too (no way to ever look a past
// event back up). Every published/approved event is fetched now;
// Calendar view hands the whole set to monthGrid unfiltered (same as
// Main Admin's own Calendar tab already does), and List view splits it
// into an upcoming grid and a newest-first "Past Events" grid below it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-past-events-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-past-events-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
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

async function clearEvents() {
  await db.prepare('DELETE FROM events').run();
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createAndPublishEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Past Events Test', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

test('Calendar view: a past event stays on the calendar (navigating back to its own month still shows it)', async () => {
  await clearEvents();
  const admin = await loginAsMainAdmin();
  await createAndPublishEvent(admin, { title: 'Long Gone Picnic', startsAt: '2020-03-15T10:00' });

  const res = await request(app).get('/events?view=calendar&month=2020-03');
  assert.equal(res.status, 200);
  assert.match(res.text, /Long Gone Picnic/, 'a published event from March 2020 should still show on March 2020\'s own calendar grid');
});

test('List view: an upcoming event and a past event both still appear, with the past one under its own "Past Events" heading', async () => {
  await clearEvents();
  const admin = await loginAsMainAdmin();
  await createAndPublishEvent(admin, { title: 'Future Fair', startsAt: '2099-06-01T10:00' });
  await createAndPublishEvent(admin, { title: 'Ancient Bake Sale', startsAt: '2020-01-01T10:00' });

  const res = await request(app).get('/events?view=list');
  assert.equal(res.status, 200);
  assert.match(res.text, /Future Fair/, 'the upcoming event should still appear');
  assert.match(res.text, /Ancient Bake Sale/, 'the past event should still appear, not be dropped entirely');
  assert.match(res.text, /class="events-past-heading">Past Events</);

  // The upcoming event has to come before the "Past Events" heading, and
  // the past event after it.
  const upcomingIdx = res.text.indexOf('Future Fair');
  const headingIdx = res.text.indexOf('Past Events');
  const pastIdx = res.text.indexOf('Ancient Bake Sale');
  assert.ok(upcomingIdx < headingIdx, 'the upcoming event should render above the Past Events heading');
  assert.ok(headingIdx < pastIdx, 'the past event should render below the Past Events heading');
});

test('List view: with no past events at all, no "Past Events" heading renders', async () => {
  await clearEvents();
  const admin = await loginAsMainAdmin();
  await createAndPublishEvent(admin, { title: 'Only Upcoming Thing', startsAt: '2099-07-01T10:00' });

  const res = await request(app).get('/events?view=list');
  assert.equal(res.status, 200);
  assert.match(res.text, /Only Upcoming Thing/);
  assert.doesNotMatch(res.text, /Past Events/);
});

test('List view: with multiple past events, the most recently passed one lists first', async () => {
  await clearEvents();
  const admin = await loginAsMainAdmin();
  await createAndPublishEvent(admin, { title: 'Oldest Past Thing', startsAt: '2019-01-01T10:00' });
  await createAndPublishEvent(admin, { title: 'Newest Past Thing', startsAt: '2021-01-01T10:00' });

  const res = await request(app).get('/events?view=list');
  const newestIdx = res.text.indexOf('Newest Past Thing');
  const oldestIdx = res.text.indexOf('Oldest Past Thing');
  assert.ok(newestIdx > -1 && oldestIdx > -1, 'both past events should appear');
  assert.ok(newestIdx < oldestIdx, 'the more recently passed event should list before the older one');
});

// Coverage for Main Admin Events tab strip - a real request: "the
// different tabs should be like the file tabs on other pages at the top
// of the page." Replaces the old dropdown-select-on-desktop/stacked-
// expandable-accordion-on-mobile pattern (item 100) with the same
// `.view-tabs`/`.view-tab` connected-folder-tab strip every other tabbed
// admin page in this app already uses (see views/admin-classifieds-
// list.ejs) - one strip, no separate mobile markup, since `.view-tabs`
// already scrolls horizontally on a narrow screen by itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-tabs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-tabs-test-uploads-${process.pid}`);
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

test('Events list: renders the shared .view-tabs strip (not the old dropdown/accordion) with all 6 tabs, active one marked', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=requests').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /<div class="view-tabs no-print">/);
  assert.doesNotMatch(page.text, /event-tabs-desktop/, 'the old desktop dropdown markup should be gone');
  assert.doesNotMatch(page.text, /event-mobile-accordion/, 'the old mobile accordion markup should be gone');

  ['Calendar', 'Drafts', 'Event Attendance', 'Archive', 'Settings'].forEach((label) => {
    assert.match(page.text, new RegExp(`class="view-tab ">${label}<`));
  });
  assert.match(page.text, /class="view-tab active">Requests/);
});

test('Events list: clicking a tab link navigates and marks the new tab active', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=archive').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="view-tab active">Archive/);
  assert.match(page.text, /<a href="\/main-admin\/events\?tab=calendar" class="view-tab ">Calendar<\/a>/);
});

test('Events builder (per-event edit page): renders its own .view-tabs strip with the 5 real request tabs', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tab Strip Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  const match = /\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location);
  const eventId = Number(match[1]);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<div class="view-tabs">/);
  ['Event Details', 'Donations', 'Food', 'Settings'].forEach((label) => {
    assert.match(page.text, new RegExp(`>${label}<`));
  });
  assert.match(page.text, /class="view-tab active">Volunteers/);
});

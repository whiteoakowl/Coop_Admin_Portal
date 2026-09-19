// Coverage for Main Admin Events tabs - a real request: "the different
// tabs should be like the file tabs on other pages at the top of the
// page," later superseded by moving every such tab strip into the shared
// nav shell (views/partials/portal-nav.ejs's own Events subpages +
// mobile-subpages-tab.ejs's dialog) instead of any per-page markup - the
// dialog now renders identically on every Main Admin page regardless of
// activeTab, so these only check the real, page-specific behavior left on
// this route (which tab's content renders, that Archive isn't a real
// tab) rather than markup that's no longer page-specific at all.
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

test('Events list: the nav shell renders all 5 Events subpages, in the shared dialog', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=requests').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  // This dialog lives in views/partials/portal-nav.ejs (via mobile-
  // subpages-tab.ejs) now, rendered the same way regardless of activeTab -
  // no more per-page dropdown/accordion markup to check for absence, and
  // no server-rendered "active" class (that's client-side now, see
  // public/js/admin-nav-accordion.js).
  const dialogMatch = /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-events">([\s\S]*?)<\/dialog>/.exec(page.text);
  assert.ok(dialogMatch, 'the Events nav-shell dialog should exist');
  ['Calendar', 'Drafts', 'Requests', 'Event Attendance', 'Settings'].forEach((label) => {
    assert.match(dialogMatch[1], new RegExp(`class="view-tab" href="[^"]*">${label}<`));
  });
});

test('Events list: each ?tab= value renders that tab\'s own page content', async () => {
  const admin = await loginAsMainAdmin();
  const settingsPage = await request(app).get('/main-admin/events?tab=settings').set('Cookie', admin.cookie);
  assert.equal(settingsPage.status, 200);
  // Only Calendar/Drafts get the "+ New Event" button (see admin-events-
  // list.ejs's own activeTab check) - a real, page-specific signal that
  // ?tab=settings actually changed what rendered, unlike the old test's
  // now-removed "active" class on a strip that's no longer page-specific.
  assert.doesNotMatch(settingsPage.text, /\+ New Event/);

  const calendarPage = await request(app).get('/main-admin/events?tab=calendar').set('Cookie', admin.cookie);
  assert.match(calendarPage.text, /\+ New Event/);
});

test('Events list: the Archive tab is gone - not a needed feature', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  // Other sections (Classifieds, Directory, Chat, Members) keep their own
  // "Archive" subpage in the shared nav shell rendered on every page, so
  // this only checks the Events item's own dialog, not the page as a
  // whole.
  const dialogMatch = /<dialog class="view-tabs page-tabs-dialog no-print" id="mobile-subpages-events">([\s\S]*?)<\/dialog>/.exec(page.text);
  assert.ok(dialogMatch, 'the Events nav-shell dialog should exist');
  assert.doesNotMatch(dialogMatch[1], />Archive</);

  const archiveTab = await request(app).get('/main-admin/events?tab=archive').set('Cookie', admin.cookie);
  assert.equal(archiveTab.status, 200);
  // An unrecognized tab param falls back to Calendar's own content.
  assert.match(archiveTab.text, /\+ New Event/);
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
  // Same later real request as the Events list's own tabs above: this
  // per-event tab strip also moved into a page-tabs-trigger/dialog pair
  // (public/js/page-tabs.js) instead of a bare inline div, so it gets
  // the same mobile popup treatment.
  assert.match(page.text, /<dialog class="view-tabs page-tabs-dialog no-print">/);
  ['Event Details', 'Donations', 'Food', 'Settings'].forEach((label) => {
    assert.match(page.text, new RegExp(`>${label}<`));
  });
  assert.match(page.text, /class="view-tab active">Volunteers/);
});

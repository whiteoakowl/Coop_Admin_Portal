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

// A real request: "make sure the title of all subpages is the same as
// the title on the subpage menu." This page's own <title>/<h1> used to
// say "Events" no matter which subpage (?tab=) was active, while the nav
// menu's own subpages read Calendar/Drafts/Requests/Event Attendance/
// Settings - now both vary together.
test('Events list: page title and <h1> match the active subpage\'s own nav label, not a fixed "Events"', async () => {
  const admin = await loginAsMainAdmin();
  const cases = [
    ['/main-admin/events?tab=calendar', 'Calendar'],
    ['/main-admin/events?tab=drafts', 'Drafts'],
    ['/main-admin/events?tab=requests', 'Requests'],
    ['/main-admin/events?tab=attendance', 'Event Attendance'],
    ['/main-admin/events?tab=settings', 'Settings'],
  ];
  for (const [url, label] of cases) {
    const page = await request(app).get(url).set('Cookie', admin.cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`<title>${label} · Sanford Homeschoolers</title>`));
    assert.match(page.text, new RegExp(`<h1>${label}</h1>`));
  }
});

test('Events builder (per-event edit page): renders its own .view-tabs strip with the real request tabs', async () => {
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
  // Unlike the Events list page above, this per-event tab strip has no
  // top-level nav entry to attach a popup to (it's reached by clicking
  // into one specific event, not from the nav) - it keeps the plain
  // inline .view-tabs strip every tabbed page used before the orange-bar
  // popup existed, per a later real request to keep that design for
  // pages with nowhere else to put the tabs.
  assert.match(page.text, /<div class="view-tabs no-print">/);
  // A later real request: "editing event should have little tabs at the
  // top. details, finance, settings, attendance" - "Event Details"
  // renamed to "Details", Finance added, Volunteers/Settings kept,
  // Attendance appended as its own link to the Registrations page. A
  // still later real request folded Donations/Food/Extra Fields into the
  // Volunteers tab itself as a pill toggle rather than their own tabs,
  // and renamed that top-level tab to "Resources/Fields".
  ['Details', 'Finance', 'Resources/Fields', 'Settings', 'Attendance'].forEach((label) => {
    assert.match(page.text, new RegExp(`>${label}<`));
  });
  assert.doesNotMatch(page.text, />Event Details</);
  assert.match(page.text, /class="view-tab active" data-builder-nav-link>Resources\/Fields/);
  assert.match(page.text, new RegExp(`href="/main-admin/events/${eventId}/registrations" class="view-tab" data-builder-nav-link>Attendance`));
  // The Resources/Fields tab's own pill toggle for its four sections.
  ['Volunteers', 'Food', 'Donations', 'Extra Fields'].forEach((label) => {
    assert.match(page.text, new RegExp(`class="day-toggle-option[^"]*">${label}<`));
  });
});

test('Events builder: Finance tab saves Accounting Category without touching Details, and the unsaved-changes dialog is present', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Finance Tab Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location)[1]);

  const detailsPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  // Price/Charged Per no longer live on the Details form itself (the
  // page-wide Add Ticket Type dialog, present on every tab, has its own
  // same-named fields for the ticket type being added - not what this
  // checks).
  const detailsFormMatch = /<form method="POST" action="\/main-admin\/events\/\d+" class="member-form-grid" id="details-form">([\s\S]*?)<\/form>/.exec(detailsPage.text);
  assert.ok(detailsFormMatch, 'the Details form should exist');
  assert.doesNotMatch(detailsFormMatch[1], /name="priceDollars"/);
  assert.doesNotMatch(detailsFormMatch[1], /name="pricePer"/);
  // A real request: "warning pop up when clicking to each page/tab that
  // you must save your changes on that page before going to the next.
  // cancel and continue buttons."
  assert.match(detailsPage.text, /id="tab-unsaved-dialog"/);
  assert.match(detailsPage.text, /you must save your changes on this page before going to the next/i);
  assert.match(detailsPage.text, /data-tab-guard-continue/);
  assert.match(detailsPage.text, /<script src="\/js\/event-builder-tab-guard\.js"><\/script>/);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.equal(financePage.status, 200);
  // A real request: "accounting category drop is all that is now needed
  // above ticket types" - the flat Price/Charged Per fields are gone from
  // the Finance form itself (the separate Add Ticket Type dialog further
  // down the page still has its own priceDollars/pricePer fields).
  const financeFormMatch = /<form method="POST" action="\/main-admin\/events\/\d+\/finance"[^>]*>([\s\S]*?)<\/form>/.exec(financePage.text);
  assert.ok(financeFormMatch, 'the Finance form should exist');
  assert.doesNotMatch(financeFormMatch[1], /name="priceDollars"/);
  assert.doesNotMatch(financeFormMatch[1], /name="pricePer"/);
  assert.match(financeFormMatch[1], /name="accountingCategoryId"/);

  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ accountingCategoryId: '', _csrf: admin.csrfToken });

  // Saving Finance shouldn't have blanked out the title/description set on Details.
  const afterDetails = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(afterDetails.text, /value="Finance Tab Test Event"/);
});

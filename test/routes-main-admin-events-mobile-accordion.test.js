// Coverage for Main Admin Events mobile accordion (item 19) - a real
// request: "on mobile, replace the tabs with stacked expandable bars -
// click the title to expand it." Desktop keeps the .view-tabs pill strip
// (.event-tabs-desktop); on mobile the same 6 tabs render as full-width
// bars stacked before/after the current tab's own content, with the
// active one styled expanded and the rest as closed bars that link to
// navigate-and-expand. Both layouts render in every response (toggled
// purely by the @media breakpoint in CSS), so route-level assertions
// check the markup directly rather than viewport size.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-mobile-accordion-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-mobile-accordion-test-uploads-${process.pid}`);
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

test('Calendar tab (first tab): its bar renders expanded with no bars above it, and the other 5 render as closed bars below', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=calendar').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /class="event-accordion-bar event-accordion-bar-active">\s*<span>Calendar/);
  const accordionBlocks = page.text.match(/<div class="event-mobile-accordion no-print">[\s\S]*?<\/div>/g);
  assert.ok(accordionBlocks && accordionBlocks.length === 2, 'expected two accordion blocks (before-active and after-active)');
  assert.doesNotMatch(accordionBlocks[0], /<a class="event-accordion-bar"/, 'Calendar is the first tab, so nothing should render before it');
  ['Drafts', 'Requests', 'Event Attendance', 'Archive', 'Settings'].forEach((label) => {
    assert.match(accordionBlocks[1], new RegExp(`<a class="event-accordion-bar" href="/main-admin/events\\?tab=\\w+">\\s*<span>${label}`));
  });
});

test('Settings tab (last tab): its bar renders expanded with all 5 other bars above it and none below', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=settings').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /class="event-accordion-bar event-accordion-bar-active">\s*<span>Settings/);
  const accordionBlocks = page.text.match(/<div class="event-mobile-accordion no-print">[\s\S]*?<\/div>/g);
  assert.ok(accordionBlocks && accordionBlocks.length === 2);
  ['Calendar', 'Drafts', 'Requests', 'Event Attendance', 'Archive'].forEach((label) => {
    assert.match(accordionBlocks[0], new RegExp(`<a class="event-accordion-bar" href="/main-admin/events\\?tab=\\w+">\\s*<span>${label}`));
  });
  assert.doesNotMatch(accordionBlocks[1], /<a class="event-accordion-bar"/, 'Settings is the last tab, so nothing should render after it');
});

test('A middle tab (Requests): closed bars appear both before and after it, and clicking one navigates to that tab', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=requests').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /class="event-accordion-bar event-accordion-bar-active">\s*<span>Requests/);
  const accordionBlocks = page.text.match(/<div class="event-mobile-accordion no-print">[\s\S]*?<\/div>/g);
  assert.ok(accordionBlocks && accordionBlocks.length === 2);
  ['Calendar', 'Drafts'].forEach((label) => {
    assert.match(accordionBlocks[0], new RegExp(`<a class="event-accordion-bar" href="/main-admin/events\\?tab=\\w+">\\s*<span>${label}`));
  });
  ['Event Attendance', 'Archive', 'Settings'].forEach((label) => {
    assert.match(accordionBlocks[1], new RegExp(`<a class="event-accordion-bar" href="/main-admin/events\\?tab=\\w+">\\s*<span>${label}`));
  });

  const draftsLink = /<a class="event-accordion-bar" href="(\/main-admin\/events\?tab=drafts)">/.exec(page.text);
  assert.ok(draftsLink);
  const draftsPage = await request(app).get(draftsLink[1]).set('Cookie', admin.cookie);
  assert.match(draftsPage.text, /class="event-accordion-bar event-accordion-bar-active">\s*<span>Drafts/);
});

test('Desktop pill tab strip (.event-tabs-desktop) still renders unchanged, hidden on mobile by CSS only', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events?tab=calendar').set('Cookie', admin.cookie);
  assert.match(page.text, /class="view-tabs event-tabs-desktop"/);
  assert.match(page.text, /href="\/main-admin\/events\?tab=calendar" class="view-tab active">Calendar/);
});

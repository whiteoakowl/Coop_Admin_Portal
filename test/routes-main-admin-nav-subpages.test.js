// Coverage for a real request: "instead of the tabs on each page, make
// them subpages under each menu tab" (desktop) / "when you click the tab
// below a menu will pop up showing the different page choices" (mobile),
// later sharpened to: "the tab should not work on mobile until you click
// the subpage. When you click the orange menu bar at the bottom it should
// show the sub pages to click." Both live in views/partials/portal-nav.ejs
// (MAIN_ADMIN_NAV_LINKS' subpages arrays + the .admin-nav-group markup for
// desktop, mobile-subpages-tab.ejs's own button+dialog pair for mobile) -
// the mobile popup is now part of the shared nav shell itself (present,
// identically, on every page) rather than any one converted page's own
// markup, so it works from anywhere in a section, not just the page that
// happens to match it. The accordion's own exclusivity/auto-open behavior
// and the popup's own open behavior are pure client-side JS (public/js/
// admin-nav-accordion.js, public/js/page-tabs.js) with no DOM available
// here, so this only locks in the server-rendered markup contract those
// scripts depend on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-nav-subpages-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-nav-subpages-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const res = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123' });
  return res.headers['set-cookie'];
}

test('Main Admin sidebar: sections with subpages render as an accordion group, not a plain link', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);

  ['Members', 'Communication', 'Events', 'Name Tags', 'Resource Links', 'Business Directory', 'Classifieds', 'Chat', 'Babysitters'].forEach((label) => {
    assert.match(res.text, new RegExp(`<details class="admin-nav-group">\\s*<summary>[\\s\\S]*?${label}`), `${label} should be an accordion group`);
  });

  // Sections with no subpages stay plain links, unaffected.
  assert.match(res.text, /<a href="\/main-admin\/accounting"[^>]*>[\s\S]*?Accounting<\/a>/);
});

test('Main Admin sidebar: each accordion group lists its real subpages', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', cookie);

  const membersGroup = /<details class="admin-nav-group">\s*<summary>[\s\S]*?Members[\s\S]*?<\/summary>\s*<div class="admin-nav-subpages">([\s\S]*?)<\/div>\s*<\/details>/.exec(res.text);
  assert.ok(membersGroup, 'Members group should be found');
  assert.match(membersGroup[1], /href="\/main-admin\/members">Members</);
  assert.match(membersGroup[1], /href="\/main-admin\/members\?tab=approvals">Approvals</);
  assert.match(membersGroup[1], /href="\/main-admin\/members\?tab=archive">Archive</);
  assert.match(membersGroup[1], /href="\/main-admin\/members\?tab=settings">Settings</);
});

test('Members/Communication/Events/Name Tags/Resource Links/Directory/Classifieds/Chat/Babysitters each still render (page content unaffected by moving their tabs into the nav shell)', async () => {
  const cookie = await loginAsMainAdmin();
  const pages = [
    '/main-admin/members',
    '/main-admin/announcements',
    '/main-admin/announcements/email',
    '/main-admin/announcements/text',
    '/main-admin/newsletter',
    '/main-admin/events',
    '/main-admin/name-tags',
    '/main-admin/resource-links',
    '/main-admin/directory',
    '/main-admin/classifieds',
    '/main-admin/forums',
    '/main-admin/babysitters',
  ];
  for (const url of pages) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `${url} should render`);
    // None of these pages carry their own page-tabs markup any more -
    // "there shouldn't be tabs on any pages anymore" - the shared nav
    // shell (checked below) is the only place it lives now.
    assert.doesNotMatch(res.text, /class="page-tabs-trigger no-print"/, `${url} should not render its own page-tabs trigger`);
  }
});

test('Mobile orange bar: every subpages-bearing item gets its own popup trigger + dialog in the shared nav shell, on any page', async () => {
  const cookie = await loginAsMainAdmin();
  // The nav shell (views/partials/portal-nav.ejs) renders identically
  // regardless of which page it's included on - a real request: "the tab
  // should not work on mobile until you click the subpage. When you click
  // the orange menu bar at the bottom it should show the sub pages to
  // click," which only works if the popup is available from anywhere, not
  // just the one page that used to carry it. Checked from a page with no
  // subpages of its own (Home) to prove that.
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const sections = [
    { slug: 'members', tabCount: 4 },
    { slug: 'communication', tabCount: 4 },
    { slug: 'events', tabCount: 5 },
    { slug: 'chat', tabCount: 2 },
    { slug: 'volunteers', tabCount: 3 },
    { slug: 'name-tags', tabCount: 3 },
    { slug: 'resource-links', tabCount: 2 },
    { slug: 'business-directory', tabCount: 3 },
    { slug: 'classifieds', tabCount: 3 },
    { slug: 'shop', tabCount: 4 },
    { slug: 'babysitters', tabCount: 3 },
  ];
  sections.forEach(({ slug, tabCount }) => {
    const dialogId = `mobile-subpages-${slug}`;
    assert.match(res.text, new RegExp(`<button type="button" class="mobile-tab-subpages-trigger" data-subpages-dialog="${dialogId}"`), `${slug} should have a mobile popup trigger`);
    const dialogMatch = new RegExp(`<dialog class="view-tabs page-tabs-dialog no-print" id="${dialogId}">([\\s\\S]*?)<\\/dialog>`).exec(res.text);
    assert.ok(dialogMatch, `${slug} should have its own dialog`);
    const linkMatches = dialogMatch[1].match(/class="view-tab"/g) || [];
    assert.equal(linkMatches.length, tabCount, `${slug} dialog should list ${tabCount} tabs, got ${linkMatches.length}`);
    assert.match(dialogMatch[1], /<button type="button" class="page-tabs-dialog-close" onclick="this\.closest\('dialog'\)\.close\(\)">Close<\/button>/, `${slug} dialog should have a close button`);
  });
});

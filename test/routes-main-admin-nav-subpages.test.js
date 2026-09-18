// Coverage for a real request: "instead of the tabs on each page, make
// them subpages under each menu tab" (desktop) / "when you click the tab
// below a menu will pop up showing the different page choices" (mobile).
// Both live in views/partials/portal-nav.ejs (MAIN_ADMIN_NAV_LINKS'
// subpages arrays + the .admin-nav-group markup) and each converted
// page's own .page-tabs-trigger/.page-tabs-dialog pair. The accordion's
// own exclusivity/auto-open behavior and the popup's own open/label-sync
// behavior are pure client-side JS (public/js/admin-nav-accordion.js,
// public/js/page-tabs.js) with no DOM available here, so this only locks
// in the server-rendered markup contract those scripts depend on.
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

test('Members/Communication/Events/Name Tags/Resource Links/Directory/Classifieds/Chat/Babysitters each render a mobile page-tabs trigger + dialog with the same tabs', async () => {
  const cookie = await loginAsMainAdmin();
  const pages = [
    { url: '/main-admin/members', tabCount: 4 },
    { url: '/main-admin/announcements', tabCount: 4 },
    { url: '/main-admin/announcements/email', tabCount: 4 },
    { url: '/main-admin/announcements/text', tabCount: 4 },
    { url: '/main-admin/newsletter', tabCount: 4 },
    { url: '/main-admin/events', tabCount: 6 },
    { url: '/main-admin/name-tags', tabCount: 3 },
    { url: '/main-admin/resource-links', tabCount: 2 },
    { url: '/main-admin/directory', tabCount: 3 },
    { url: '/main-admin/classifieds', tabCount: 3 },
    { url: '/main-admin/forums', tabCount: 3 },
    { url: '/main-admin/babysitters', tabCount: 3 },
  ];
  for (const { url, tabCount } of pages) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `${url} should render`);
    assert.match(res.text, /<button type="button" class="page-tabs-trigger no-print"><span class="page-tabs-trigger-label">/, `${url} should have a page-tabs trigger`);
    assert.match(res.text, /<dialog class="view-tabs page-tabs-dialog no-print">/, `${url} should have a page-tabs dialog`);
    const linkMatches = res.text.match(/class="view-tab(?=["\s])[^"]*"/g) || [];
    assert.equal(linkMatches.length, tabCount, `${url} dialog should list ${tabCount} tabs, got ${linkMatches.length}`);
    assert.match(res.text, /<button type="button" class="page-tabs-dialog-close" onclick="this\.closest\('dialog'\)\.close\(\)">Close<\/button>/, `${url} dialog should have a close button`);
  }
});

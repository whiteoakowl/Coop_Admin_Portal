// Real HTTP-level coverage for a real request: "make bypass setup/
// cleanup cards it's own selection for bulk printing in the dropdown
// menu. it should print 8 cards to a sheet. same size as the name tags
// and schedule cards." The bypass badge (db/bootstrapPg.js's
// seedIfMissing, routes/checkout.js's findSetupCleanupBypassBadge) used
// to be just one row mixed into the regular Setup/Cleanup Badges
// checklist - it gets its own dedicated "how many copies?" print panel
// now (routes/admin-misc-badges.js and routes/main-admin-name-tags.js),
// reusing the exact same admin-misc-badges-print/main-admin-misc-badges-
// print view every other misc badge already prints through (8-per-page
// .badge-sheet grid, same card size), so both portals get covered here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `bypass-badge-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `bypass-badge-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const { createSection, addItem } = require('../utils/taskList');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function csrfFrom(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  return { cookie, csrfToken: csrfFrom(page.text), page };
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  return { cookie, csrfToken: csrfFrom(page.text), page };
}

test('Co-op Admin Design/Print: the dropdown offers Setup/Cleanup Bypass Badges as its own option with its own section', async () => {
  const { page } = await loginAsAdmin();
  assert.match(page.text, /<option value="bypassBadge"[^>]*>Setup\/Cleanup Bypass Badges<\/option>/);
  assert.match(page.text, /<div id="print-bypassBadge-section" class="manage-section" hidden>/);
  assert.match(page.text, /name="quantity"/);
});

test('Co-op Admin: the bypass badge no longer appears in the regular Setup/Cleanup Badges checklist', async () => {
  const { page } = await loginAsAdmin();
  const sectionStart = page.text.indexOf('id="print-setupCleanupBadges-section"');
  const sectionEnd = page.text.indexOf('id="print-bypassBadge-section"');
  const panelHtml = page.text.slice(sectionStart, sectionEnd);
  assert.doesNotMatch(panelHtml, /Setup\/Cleanup Bypass Card/, 'the bypass badge should be filtered out of the regular checklist');
});

test('Co-op Admin: a real task\'s own badge still shows in the regular Setup/Cleanup Badges checklist', async () => {
  const sectionId = await createSection('monday', 'Kitchen Team', null);
  await addItem(sectionId, 'Wipe down all counters and sinks');
  const { page } = await loginAsAdmin();
  const sectionStart = page.text.indexOf('id="print-setupCleanupBadges-section"');
  const sectionEnd = page.text.indexOf('id="print-bypassBadge-section"');
  const panelHtml = page.text.slice(sectionStart, sectionEnd);
  assert.match(panelHtml, /Wipe down all counters and sinks/);
});

test('POST /admin/design/badges/bypass/print prints the requested quantity, 8 cards per sheet, same card size as name tags', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/design/badges/bypass/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ quantity: '9', _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Print Setup\/Cleanup Bypass Badges<\/h1>/);
  const pages = res.text.match(/badge-sheet-page badge-sheet/g);
  assert.equal(pages.length, 2, '9 cards at 8 per sheet should produce 2 pages');
  const cardTitleCount = (res.text.match(/Setup\/Cleanup Bypass Card/g) || []).length;
  assert.equal(cardTitleCount, 9, 'exactly 9 copies of the bypass badge should be rendered');
  // Same card-size mechanism every other misc badge print already uses -
  // BADGE_WIDTH/BADGE_HEIGHT (336x216), identical to CARD_WIDTH/
  // CARD_HEIGHT for schedule cards and name tags.
  assert.match(res.text, /width:336px; height:216px/);
});

test('POST /admin/design/badges/bypass/print clamps quantity to 1-50', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const tooMany = await request(app)
    .post('/admin/design/badges/bypass/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ quantity: '999', _csrf: csrfToken });
  assert.equal((tooMany.text.match(/badge-sheet-page badge-sheet/g) || []).length, Math.ceil(50 / 8));

  const zeroOrJunk = await request(app)
    .post('/admin/design/badges/bypass/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ quantity: 'not-a-number', _csrf: csrfToken });
  assert.equal((zeroOrJunk.text.match(/Setup\/Cleanup Bypass Card/g) || []).length, 1, 'an invalid quantity should default to 1 copy, not 0 or NaN');
});

test('Main Admin Name Tags/Print: same dropdown option, same dedicated section, same print flow', async () => {
  const { page, cookie, csrfToken } = await loginAsMainAdmin();
  assert.match(page.text, /<option value="bypassBadge"[^>]*>Setup\/Cleanup Bypass Badges<\/option>/);
  assert.match(page.text, /<div id="print-bypassBadge-section" class="manage-section" hidden>/);

  const res = await request(app)
    .post('/main-admin/name-tags/badges/bypass/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ quantity: '3', _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Print Setup\/Cleanup Bypass Badges<\/h1>/);
  assert.equal((res.text.match(/badge-sheet-page badge-sheet/g) || []).length, 1);
  assert.equal((res.text.match(/Setup\/Cleanup Bypass Card/g) || []).length, 3);
});

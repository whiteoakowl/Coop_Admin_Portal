// A real request: "main admin, members, no description. When you click
// edit permissions you should then only see one button for save
// permissions. Once you click save you see all the original buttons
// again. Approvals tab, no description. Delete descriptions under member
// settings as well. No description under archive members."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-cleanup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-cleanup-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('no description text on Members, Archive, Approvals, or Settings tabs', async () => {
  const cookie = await loginAsMainAdmin();

  const membersPage = await request(app).get('/main-admin/members?tab=members').set('Cookie', cookie);
  assert.doesNotMatch(membersPage.text, /The full family\/member roster/);

  const archivePage = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.doesNotMatch(archivePage.text, /The full family\/member roster/);

  const approvalsPage = await request(app).get('/main-admin/members?tab=approvals').set('Cookie', cookie);
  assert.doesNotMatch(approvalsPage.text, /Self-registered members awaiting review/);

  const settingsPage = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.doesNotMatch(settingsPage.text, /Use <code>\{\{name\}\}<\/code>/);
  assert.doesNotMatch(settingsPage.text, /an applicant must scroll through this/);
  assert.doesNotMatch(settingsPage.text, /Leave the fee at \$0 to hide the fee amount/);
  assert.doesNotMatch(settingsPage.text, /Extra questions shown on the Parent\/Guardian and Student sections/);
});

// A real request: "Remove from members page the following buttons, edit
// member list, edit permissions, add/edit sections. Change to bulk edit
// button." Edit Permissions/Save Permissions and Add/Edit Sections are
// gone from this toolbar - Sections management moved to a card on the
// Settings tab, and section/portal assignment moved into the Bulk Edit
// dialog (see test/routes-main-admin-members-edit-mode-actions.test.js).
test('the Members toolbar has Edit Permissions/Add-Edit Sections gone', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members?tab=members').set('Cookie', cookie);
  // A real request: "Filter button should be on the same row as icons"
  // split the old single toolbar row into two (.roster-btn-row.roster-
  // btn-row-fit-text.main-admin-members-btn-row each) - checking the
  // whole page rather than slicing out one row's own substring (see
  // test/routes-main-admin-members-mobile-button-order.test.js's own
  // comment on why a regex can no longer safely carve one out).
  assert.doesNotMatch(res.text, /data-permissions-toggle/);
  assert.doesNotMatch(res.text, /data-permissions-save/);
  assert.doesNotMatch(res.text, />Edit Permissions</);
  assert.doesNotMatch(res.text, />Add\/Edit Sections</);
  assert.match(res.text, /\+ Add Member/);
  // A later real request: "change export and print buttons to icons" /
  // "all pages/subpages with print, export, import, or download buttons
  // should be changed to icons" - Import/Export are now icon-only
  // buttons (aria-label, no visible text).
  assert.match(res.text, /aria-label="Import"/);
  assert.match(res.text, /aria-label="Export CSV"/);
  // A later real request: "delete create account button. every member
  // already automatically has an account. instead there can be an add
  // member button" - + Add Member (already present above) replaces it.
  assert.doesNotMatch(res.text, />Create Accounts</);
});

test('Settings tab is a card grid, with a Sections card linking to /main-admin/sections', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  // A real request ("Members Settings. Mobile. Settings cards should be
  // two columns, shrink to fit") added a 2nd class to this grid
  // (settings-hub-card-grid) alongside the shared team-card-grid one.
  assert.match(res.text, /<div class="team-card-grid settings-hub-card-grid">/);
  assert.match(res.text, /href="\/main-admin\/sections"[\s\S]*?Sections/);
  assert.match(res.text, /href="\/main-admin\/members\?tab=settings&settingsTab=grade-levels"/);
  // The old in-page tab strip (a <div class="view-tabs"> of <a
  // class="view-tab"> links) is gone - note .view-tabs/.view-tab are
  // also reused, unrelatedly, by this page's own mobile subpages popup
  // dialog, so this checks for the specific old tab-strip div rather
  // than asserting the class is absent sitewide.
  assert.doesNotMatch(res.text, /<div class="view-tabs no-print">/);

  const gradeLevelsPage = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  assert.match(gradeLevelsPage.text, /Grade Level Settings/);
  assert.doesNotMatch(gradeLevelsPage.text, /<div class="team-card-grid">/, 'a specific settings sub-page shows its own content, not the card grid');
  assert.match(gradeLevelsPage.text, /href="\/main-admin\/members\?tab=settings">&larr; Settings</);
});

// A real request: "Main admin portal. Members. Settings. All settings
// pages should have the title of the page on the page." Every
// settingsTab sub-page shows a heading matching its own Settings-grid
// card label - approval-denial was the one gap (its own two Approval/
// Denial Letter sections had no overall page title of their own).
test('every Members > Settings sub-page shows its own title/heading on the page', async () => {
  const cookie = await loginAsMainAdmin();
  const pages = [
    { settingsTab: 'grade-levels', heading: 'Grade Level Settings' },
    { settingsTab: 'fee-payment', heading: 'Membership Fee &amp; Payment' },
    { settingsTab: 'form-fields', heading: 'Membership Form Fields' },
    { settingsTab: 'approval-denial', heading: 'Approval/Denial Messages' },
    { settingsTab: 'handbook', heading: 'Policy Handbook' },
  ];
  for (const { settingsTab, heading } of pages) {
    const res = await request(app).get(`/main-admin/members?tab=settings&settingsTab=${settingsTab}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`<h[12][^>]*>${heading}<`), `expected a visible heading for settingsTab=${settingsTab}`);
  }
});

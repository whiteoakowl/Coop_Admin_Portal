// Coverage for a real request: "Parent portal events, events page should
// show the same event calendar that is on main admin portal." Main Admin
// (views/admin-events-list.ejs) and the shared member-facing /events
// page (views/events-list.ejs, routes/events.js) already built their
// calendar DATA from the same utils/events.js monthGrid() - they now
// share the exact same RENDERING too, via views/partials/
// event-calendar-grid.ejs (month/year dropdowns + narrow Prev/Next,
// replacing the member-facing page's own older, simpler markup). Also
// covers a real bug this extraction fixed along the way: Main Admin's
// month/year <select> onchange called window.fullscreenNavigate(...),
// which no longer exists anywhere on that page since a separate real
// request ("remove full screen button and feature from all portal
// pages") deleted its script include - the dropdowns silently did
// nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-shared-calendar-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-shared-calendar-test-uploads-${process.pid}`);
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
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function createParentAndLogin() {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Shared Calendar Family')").run()).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Shared Calendar Parent', ?, ?, 'parent', ?, 1, 1)")
    .run(code, code, familyId);
  const email = 'shared-calendar-parent@example.com';
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return loginRes.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Parent Portal Events calendar renders the same month/year-dropdown calendar grid as Main Admin', async () => {
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Shared Calendar Event', to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();

  const parentCookie = await createParentAndLogin();
  const adminCookie = await loginAsMainAdmin();

  const parentPage = await request(app).get('/events?view=calendar').set('Cookie', parentCookie);
  assert.equal(parentPage.status, 200);
  const adminPage = await request(app).get('/main-admin/events?tab=calendar&view=calendar').set('Cookie', adminCookie);
  assert.equal(adminPage.status, 200);

  // Both pages render the exact same calendar nav row markup.
  for (const html of [parentPage.text, adminPage.text]) {
    assert.match(html, /class="roster-btn-row event-calendar-nav-row" data-fixed-column-widths="1fr 2fr 2fr 1fr"/);
    assert.match(html, /id="event-month-select"/);
    assert.match(html, /id="event-year-select"/);
    assert.match(html, /class="roster-table condensed-table event-calendar-table"/);
    // A real bug this extraction fixed: the old inline onchange called a
    // function (window.fullscreenNavigate) that no longer exists on this
    // page since Full Screen View was removed everywhere.
    assert.doesNotMatch(html, /fullscreenNavigate/);
  }

  // The event pill links differ (Main Admin's own builder vs. the public
  // event detail page) - each still lands on its own right target.
  assert.match(parentPage.text, /href="\/events\/\d+" class="badge-pill/);
  assert.match(adminPage.text, /href="\/main-admin\/events\/\d+\/builder" class="badge-pill/);

  // Parent Portal's own nav shell (not the generic public site header)
  // stays on this shared page, same as Student Portal already got for
  // the same reason (a real bug report: "dashboard panel tab bar should
  // still be on the bottom... not visible on calendar page").
  assert.match(parentPage.text, /class="admin-mobile-tabs"/);
  assert.doesNotMatch(parentPage.text, /class="site-header"/);
});

test('a logged-out visitor to /events?view=calendar still gets the plain public site header and calendar', async () => {
  await db
    .prepare("INSERT INTO events (title, starts_at, status, visibility) VALUES ('Public Shared Calendar Event', to_char(now() + interval '5 days', 'YYYY-MM-DD HH24:MI:SS'), 'published', 'public')")
    .run();

  const res = await request(app).get('/events?view=calendar');
  assert.equal(res.status, 200);
  assert.match(res.text, /class="site-header"/);
  assert.match(res.text, /id="event-month-select"/);
});

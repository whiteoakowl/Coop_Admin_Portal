// Coverage for the Main Admin homepage's Families/Parents/Students
// counters and the settings gear - real requests: "should show a counter
// of how many families, how many parents and how many students," "roles
// and permissions, website settings, and co-op admin portal links should
// all be under the main admin settings gear icon," and later "clicking
// on the settings tab should not show subpages. instead all subpages
// should be rows of cards for each setting category" (the gear used to
// open a dropdown of these same destinations right in the sidebar - it's
// now a plain link to /main-admin/settings, which renders that card grid
// instead - see test/routes-main-admin-settings-hub.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-home-counters-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-home-counters-test-uploads-${process.pid}`);
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('GET /main-admin shows Families/Parents/Students counters and a plain settings-gear link, without the relocated dashboard cards', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('HomeCounterFamily') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Parent', 'counter-parent-1', 'parent', ?, 1)").run(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Kid One', 'counter-kid-1', 'student', ?, 1)").run(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Kid Two', 'counter-kid-2', 'student', ?, 1)").run(familyId);
  // An archived (active=0) member must not count.
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Archived Kid', 'counter-kid-archived', 'student', ?, 0)").run(familyId);

  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // A later request: "should be called homepage, remove the description,
  // people title should say members."
  assert.match(res.text, /<h1>Homepage<\/h1>/);
  assert.doesNotMatch(res.text, /control center for the whole platform/);
  assert.match(res.text, /<h2>Members<\/h2>/);
  assert.doesNotMatch(res.text, /<h2>People<\/h2>/);

  // A later request: "main admin, homepage, member count. should look
  // like the member count on co-op admin portal homepage" - reuses that
  // page's own .family-student-counts-card/-row markup (views/admin-
  // dashboard.ejs) instead of the plain .totals-card/stat-value grid this
  // used to render.
  assert.match(res.text, /<span class="family-student-row-label">Parents<\/span>\s*<span class="family-student-row-value">1<\/span>/);
  assert.match(res.text, /<span class="family-student-row-label">Students<\/span>\s*<span class="family-student-row-value">2<\/span>/);
  assert.match(res.text, /<span class="family-student-row-label">Families<\/span>\s*<span class="family-student-row-value">1<\/span>/);
  assert.match(res.text, /<span class="family-student-row-label">Teachers<\/span>/);
  assert.match(res.text, /<span class="family-student-row-label">Admins<\/span>/);

  // Pending-requests counters (item 6) each link straight to their own
  // request page. A later request added Membership Requests to this same
  // "Pending Requests" section, reusing the account-approval count/link
  // ("pending requests should also include membership requests and link").
  // Once every member got their own portal account and the standalone
  // Users tab was removed, this link was repointed at Members > Approvals
  // (the same underlying pending member_accounts queue - see
  // utils/membershipApprovals.js's own header comment).
  assert.match(res.text, /class="totals-item" href="\/main-admin\/members\?tab=approvals"[^]*?Membership Requests/);
  assert.match(res.text, /href="\/main-admin\/events\?tab=requests"[^]*?Event Requests/);
  assert.match(res.text, /href="\/main-admin\/babysitters\?tab=approvals"[^]*?Babysitter Approvals/);
  assert.match(res.text, /href="\/main-admin\/photos#pending-photos"[^]*?Photo Submissions/);
  assert.match(res.text, /href="\/main-admin\/directory\?tab=requests"[^]*?Business Directory Requests/);
  assert.match(res.text, /href="\/main-admin\/classifieds\?tab=requests"[^]*?Classifieds Requests/);

  // Roles & Permissions/Website/Co-op Admin Portal/Users cards are all
  // gone from the homepage grid - they moved to the gear dropdown below
  // (item 6: "remove user settings - user settings should be under the
  // gear setting icon").
  assert.doesNotMatch(res.text, /Manage Roles/);
  assert.doesNotMatch(res.text, /Manage Website/);
  assert.doesNotMatch(res.text, /Open Co-op Admin/);
  assert.doesNotMatch(res.text, /Manage Users/);

  // The gear itself is now a plain link straight to the settings hub
  // (test/routes-main-admin-settings-hub.test.js covers the card grid of
  // destinations that page renders) - not a dropdown listing them here in
  // the sidebar. A later request ("Switch portal, profile icon, settings
  // icon should all be top right of screen") moved this link out of the
  // sidebar and into the top-right .admin-page-corner-actions header.
  assert.doesNotMatch(res.text, />Settings<\/summary>/);
  assert.match(res.text, /class="admin-corner-link" href="\/main-admin\/settings">\s*<svg class="icon"><use href="#icon-gear"\/><\/svg>\s*Settings/);
});

test('a non-Main-Admin portal keeps its plain Settings link, no gear dropdown', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('PlainSettingsFamily') RETURNING id").get()).id;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Plain Settings Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
    .get(code, code, familyId);
  const email = 'plain-settings-parent@example.com';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
    .get(parentInfo.id, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const res = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /portal-switcher-details/);
  assert.match(res.text, /href="\/portal\/settings"/);
});

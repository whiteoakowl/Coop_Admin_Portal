// A real request: "Icons at the top of all the portals. The portals
// button should be a computer icon. There should also be a profile icon
// with image circle. Remove full screen button and feature from all
// portal pages." Covers both nav shells (views/partials/admin-nav.ejs for
// Co-op Admin, views/partials/portal-nav.ejs for every other portal):
// the old #fullscreen-toggle-btn/-mobile pair and their script include
// are gone, "My Portals"/"Switch Portal" now uses #icon-monitor instead
// of #icon-users, and a new My Profile link uses #icon-user-circle.
// Kiosk Mode (a separate, standalone page) keeps its own fullscreen
// toggle untouched - test/routes-kiosk-home.test.js already covers that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-nav-icons-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-nav-icons-test-uploads-${process.pid}`);
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

test('Co-op Admin (admin-nav.ejs): no Full Screen View button/script, My Portals uses a computer icon, My Profile appears', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(page.status, 200);

  assert.doesNotMatch(page.text, /id="fullscreen-toggle-btn"/);
  assert.doesNotMatch(page.text, /id="fullscreen-toggle-btn-mobile"/);
  assert.doesNotMatch(page.text, /Full Screen View/);
  assert.doesNotMatch(page.text, /fullscreen-toggle\.js/);
  assert.doesNotMatch(page.text, /fullscreen-exit-pin-dialog/);

  assert.match(page.text, /<a class="admin-corner-link" href="\/portal">\s*<svg class="icon"><use href="#icon-monitor"\/><\/svg>\s*My Portals/);
  assert.match(page.text, /<a class="admin-corner-link" href="\/admin\/settings">\s*<svg class="icon"><use href="#icon-user-circle"\/><\/svg>\s*My Profile/);
  assert.match(page.text, /aria-label="My Profile"><svg class="icon"><use href="#icon-user-circle"\/>/);
});

test('Parent Portal (portal-nav.ejs): no Full Screen View button/script, My Profile in the corner, Switch Portal uses a computer icon', async () => {
  const { generateMemberCode } = require('../utils/members');
  const { hashPassword } = require('../utils/portalAuth');
  const db = require('../db');

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Icon Test Family')).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run('Icon Test Parent', parentCode, parentCode, familyId);
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, 'icontest@example.com', hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get('icontest@example.com');
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email: 'icontest@example.com', password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);

  assert.doesNotMatch(page.text, /id="fullscreen-toggle-btn"/);
  assert.doesNotMatch(page.text, /id="fullscreen-toggle-btn-mobile"/);
  assert.doesNotMatch(page.text, /Full Screen View/);
  assert.doesNotMatch(page.text, /fullscreen-toggle\.js/);

  // A later real request: "Clicking on the profile icon at the top on
  // every portal should be the member's full profile membership form so
  // that they can edit it" - My Profile now points at /portal/profile
  // (views/portal-profile.ejs), not the generic account-settings page
  // settingsHref still resolves to for the gear icon.
  assert.match(page.text, /<a class="admin-corner-link" href="\/portal\/profile">\s*<svg class="icon"><use href="#icon-user-circle"\/><\/svg>\s*My Profile/);
  assert.match(page.text, /aria-label="My Profile"><svg class="icon"><use href="#icon-user-circle"\/>/);
});

test('Main Admin (portal-nav.ejs, multi-role account): Switch Portal link uses a computer icon, not the generic users icon', async () => {
  const { generateMemberCode } = require('../utils/members');
  const { hashPassword } = require('../utils/portalAuth');
  const db = require('../db');

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Multi Role Family')).lastInsertRowid;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run('Multi Role Parent', code, code, familyId);
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, 'multirole@example.com', hashPassword('testpassword123'));
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get('multirole@example.com');
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, teacherRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email: 'multirole@example.com', password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<summary><svg class="icon"><use href="#icon-monitor"\/><\/svg> Switch Portal<\/summary>/);
  assert.match(page.text, /aria-label="Switch Portal"><svg class="icon"><use href="#icon-monitor"\/>/);
});

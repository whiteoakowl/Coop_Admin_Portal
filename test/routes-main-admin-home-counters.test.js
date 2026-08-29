// Coverage for the Main Admin homepage's Families/Parents/Students
// counters and the settings-gear dropdown - real requests: "should show
// a counter of how many families, how many parents and how many
// students" and "roles and permissions, website settings, and co-op
// admin portal links should all be under the main admin settings gear
// icon."
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

test('GET /main-admin shows Families/Parents/Students counters and the gear dropdown, without the relocated dashboard cards', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('HomeCounterFamily') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Parent', 'counter-parent-1', 'parent', ?, 1)").run(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Kid One', 'counter-kid-1', 'student', ?, 1)").run(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Counter Kid Two', 'counter-kid-2', 'student', ?, 1)").run(familyId);
  // An archived (active=0) member must not count.
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Archived Kid', 'counter-kid-archived', 'student', ?, 0)").run(familyId);

  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /<span class="stat-value">1<\/span>\s*<span class="stat-label">Families<\/span>/);
  assert.match(res.text, /<span class="stat-value">1<\/span>\s*<span class="stat-label">Parents<\/span>/);
  assert.match(res.text, /<span class="stat-value">2<\/span>\s*<span class="stat-label">Students<\/span>/);

  // Roles & Permissions/Website/Co-op Admin Portal cards are gone from the
  // homepage grid - they moved to the gear dropdown below.
  assert.doesNotMatch(res.text, /Manage Roles/);
  assert.doesNotMatch(res.text, /Manage Website/);
  assert.doesNotMatch(res.text, /Open Co-op Admin/);
  // Users stays as its own homepage card.
  assert.match(res.text, /Manage Users/);

  // The gear dropdown carries all four destinations.
  assert.match(res.text, /href="\/main-admin\/users">Users</);
  assert.match(res.text, /href="\/main-admin\/roles">Roles &amp; Permissions</);
  assert.match(res.text, /href="\/main-admin\/website">Website</);
  assert.match(res.text, /href="\/admin">Co-op Admin Portal</);
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

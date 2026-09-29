// Coverage for a real request: "Parent portal, name tag form and
// absence/late form should go to the kiosk form. It should just be a
// subpage on the parent portal, still have access to other portal
// pages. These forms are still the same forms with the same features."
// /name-tag and /absence are genuinely public, no-login, kiosk-shared
// forms (routes/absence.js's own comment: "public, no-login endpoint")
// that used to always render the plain kiosk-style shell, even for a
// signed-in parent - losing their bottom tab bar and every other portal
// link, exactly the bug /events had before its own fix (see views/
// events-list.ejs). A signed-in parent now gets the real Parent Portal
// nav shell around this same unchanged form; a signed-out visitor (the
// real kiosk case) still gets the plain kiosk shell with its own
// "Return to Home Screen" link.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-absence-portal-shell-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-absence-portal-shell-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let seedCounter = 0;
async function createParentAndLogin() {
  seedCounter += 1;
  const n = seedCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Portal Shell Family ${n}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Portal Shell Parent ${n}`, code, code, familyId);
  const email = `portal-shell-parent-${n}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return loginRes.headers['set-cookie'];
}

test('a signed-in parent visiting /name-tag gets the Parent Portal nav shell, not the bare kiosk page', async () => {
  const cookie = await createParentAndLogin();
  const res = await request(app).get('/name-tag').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="admin-mobile-tabs"/);
  assert.doesNotMatch(res.text, /class="public-page"/);
  assert.doesNotMatch(res.text, /Return to Home Screen/);
  // Same form, unchanged.
  assert.match(res.text, /<h1>Name Tag Form<\/h1>/);
  assert.match(res.text, /id="name-tag-form"/);
  assert.match(res.text, /action="\/name-tag\/submit"/);
});

test('a signed-in parent visiting /absence gets the Parent Portal nav shell, not the bare kiosk page', async () => {
  const cookie = await createParentAndLogin();
  const res = await request(app).get('/absence').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="admin-mobile-tabs"/);
  assert.doesNotMatch(res.text, /class="public-page"/);
  assert.doesNotMatch(res.text, /Return to Home Screen/);
  assert.match(res.text, /<h1>Absence\/Late Form<\/h1>/);
  assert.match(res.text, /id="absence-form"/);
  assert.match(res.text, /action="\/absence\/submit"/);
});

test('a signed-out kiosk visitor still gets the plain kiosk shell on /name-tag and /absence', async () => {
  const nameTag = await request(app).get('/name-tag');
  assert.equal(nameTag.status, 200);
  assert.match(nameTag.text, /class="public-page"/);
  assert.match(nameTag.text, /Return to Home Screen/);
  assert.doesNotMatch(nameTag.text, /class="admin-mobile-tabs"/);

  const absence = await request(app).get('/absence');
  assert.equal(absence.status, 200);
  assert.match(absence.text, /class="public-page"/);
  assert.match(absence.text, /Return to Home Screen/);
  assert.doesNotMatch(absence.text, /class="admin-mobile-tabs"/);
});

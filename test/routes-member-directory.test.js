// Route-level coverage for Member Directory (Community & Commerce track,
// item 5). See utils/memberDirectory.js's own comments and
// supabase/migrations/20260825050000_member_directory.sql for the design
// this exercises: a fixed field-visibility allowlist a Main Admin opts
// fields INTO (nothing shown by default), and a per-member opt-out any
// account can set for itself or its own family.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-directory-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-directory-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active, phone, email) VALUES (?, ?, ?, 'parent', ?, 1, 1, '555-1234', ?)")
    .run(`Parent ${familyCounter}`, code, code, familyId, `parent${familyCounter}@example.com`);
  const email = `login${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/member-directory' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/member-directory').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, name: `Parent ${familyCounter}` };
}

test('a field a Main Admin has not turned on never appears, even though the data exists', async () => {
  const parent = await createParentAccount();
  const list = await request(app).get('/member-directory').set('Cookie', parent.cookie);
  assert.match(list.text, new RegExp(parent.name));
  // Phone was seeded on the member row but no field was ever turned on -
  // must not leak into the page.
  assert.doesNotMatch(list.text, /555-1234/);
});

test('a Main Admin can turn a field on and it then shows for every viewer', async () => {
  const admin = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/member-directory/fields')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ fields: ['phone', 'email'], _csrf: admin.csrfToken });

  const parent = await createParentAccount();
  const list = await request(app).get('/member-directory').set('Cookie', parent.cookie);
  assert.match(list.text, /555-1234/);
});

test('the member directory requires sign-in - no public browsing', async () => {
  const res = await request(app).get('/member-directory');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('a member can opt themselves out and it removes them from browsing immediately', async () => {
  const parent = await createParentAccount();
  const before = await request(app).get('/member-directory').set('Cookie', parent.cookie);
  assert.match(before.text, new RegExp(parent.name));

  await request(app).post(`/member-directory/${parent.memberId}/opt-out`).set('Cookie', parent.cookie).type('form').send({ _csrf: parent.csrfToken });

  const after = await request(app).get('/member-directory').set('Cookie', parent.cookie);
  assert.doesNotMatch(after.text, new RegExp(parent.name));
});

test('an account cannot opt out a member outside its own family', async () => {
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app).post(`/member-directory/${parentB.memberId}/opt-out`).set('Cookie', parentA.cookie).type('form').send({ _csrf: parentA.csrfToken });
  assert.equal(res.status, 403);

  const stillIn = await request(app).get('/member-directory').set('Cookie', parentA.cookie);
  assert.match(stillIn.text, new RegExp(parentB.name));
});

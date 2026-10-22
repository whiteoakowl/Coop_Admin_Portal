// Real HTTP-level coverage for a real request: "Teacher portal, remove
// the following tabs and features. Business directory, classifieds,
// resources, store, academics, babysitters, reading challenge, store,
// accounting and events. Make sure all teacher portal tabs, buttons and
// pages stay in teacher portal." Resources/Academics/Reading Challenge/
// the real Babysitters directory page already live under
// requirePortal('parent') (routes/parent-portal.js) and were never
// reachable by a teacher-only account at all - covered here as a
// regression guard, not a new fix. Business Directory, Classifieds,
// Shop, Accounting, and Events (routes/directory.js, classifieds.js,
// store.js, accounting.js, events.js) were open to any authenticated
// portal account - middleware/portalAuth.js's new blockTeacherOnlyAccounts
// closes that for an account whose ONLY portal role is 'teacher', while
// leaving a teacher-AND-parent account (the real "self-signed-up to also
// teach a class" case) fully unaffected, and never touching logged-out/
// public access to Events/Directory/Classifieds' own public-visibility items.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-portal-containment-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-portal-containment-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

let classCounter = 0;
async function makeClass() {
  classCounter += 1;
  return (
    await db
      .prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, ?) RETURNING id")
      .get(`Containment Test Class ${classCounter}`)
  ).id;
}

async function addRole(accountId, roleKey) {
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
}

async function loginTeacherOnly(email) {
  const classId = await makeClass();
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Teacher Only Member', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  await addRole(accountId, 'teacher');
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return loginRes.headers['set-cookie'];
}

async function loginTeacherAndParent(email) {
  const classId = await makeClass();
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Teacher Parent Member', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  await addRole(accountId, 'teacher');
  await addRole(accountId, 'parent');
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return loginRes.headers['set-cookie'];
}

const BLOCKED_PAGES = ['/directory', '/classifieds', '/store', '/accounting', '/events'];

test('a teacher-only account is blocked from Business Directory/Classifieds/Shop/Accounting/Events', async (t) => {
  const cookie = await loginTeacherOnly('teacher-only-blocked@example.com');

  for (const url of BLOCKED_PAGES) {
    await t.test(`GET ${url} is a 403, not the full member page`, async () => {
      const res = await request(app).get(url).set('Cookie', cookie);
      assert.equal(res.status, 403);
      assert.match(res.text, /isn&#39;t available from the Co-op Teacher Portal/);
      assert.match(res.text, /Back to Co-op Teacher Portal/);
    });
  }

  await t.test('the already-parent-only pages (Resources/Academics/Reading Challenge/Babysitters) are still unreachable too', async () => {
    for (const url of ['/parent/resources', '/parent/academics', '/parent/reading', '/parent/babysitters']) {
      const res = await request(app).get(url).set('Cookie', cookie);
      assert.equal(res.status, 403, `${url} should still be blocked (requirePortal('parent'))`);
    }
  });
});

test('an account that is BOTH teacher and parent keeps full access to these pages', async (t) => {
  const cookie = await loginTeacherAndParent('teacher-and-parent@example.com');

  for (const url of BLOCKED_PAGES) {
    await t.test(`GET ${url} still renders normally for a teacher+parent account`, async () => {
      const res = await request(app).get(url).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.text, /isn&#39;t available from the Co-op Teacher Portal/);
    });
  }
});

test('a logged-out visitor can still browse public Events/Directory/Classifieds listings, unaffected', async (t) => {
  for (const url of ['/events', '/directory', '/classifieds']) {
    await t.test(`GET ${url} with no session still renders the public page, not a 403`, async () => {
      const res = await request(app).get(url);
      assert.equal(res.status, 200);
    });
  }
});

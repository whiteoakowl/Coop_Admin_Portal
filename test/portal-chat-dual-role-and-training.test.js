// Coverage for a real bug report: "Teacher portal. When clicking on
// training tab it goes to parent portal. It should stay in teacher
// portal... Chat groups on teachaer portal switch to parent portal as
// well." Both bugs only showed up for a DUAL-ROLE (parent + teacher)
// account, since sharedPortalTitle's own fallback priority
// (middleware/portalAuth.js) is Parent > Student > Teacher whenever the
// ?portal= query param isn't there to disambiguate - see routes/
// forums.js's own portalParam/withPortal comment for exactly which link
// used to drop that param one click deeper into Chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-chat-dual-role-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-chat-dual-role-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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
  return { cookie: loginRes.headers['set-cookie'] };
}

async function createGeneralCategory(admin) {
  const page = await request(app).get('/main-admin').set('Cookie', admin.cookie);
  const csrfToken = extractCsrf(page.text);
  const res = await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Dual Role Chat', scope: 'general', _csrf: csrfToken });
  assert.equal(res.status, 302);
  const row = await db.prepare("SELECT id FROM forum_categories WHERE name = 'Dual Role Chat'").get();
  return row.id;
}

let counter = 0;
async function createDualRoleAccount() {
  counter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Dual Role Member', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  const email = `dual-role-${counter}@example.com`;
  const password = 'testpassword123';
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword(password))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal' });
  return { cookie: loginRes.headers['set-cookie'], memberId };
}

test('a dual-role (parent+teacher) account clicking Chat from Co-op Teacher Portal stays in Co-op Teacher Portal on the category and thread pages too', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createGeneralCategory(admin);
  const dual = await createDualRoleAccount();

  const list = await request(app).get('/forums?portal=teacher').set('Cookie', dual.cookie);
  assert.equal(list.status, 200);
  assert.match(list.text, /<p class="portal-nav-title">Co-op Teacher Portal<\/p>/);
  // The category link on the list page must carry ?portal=teacher
  // forward - this is the exact link that used to drop it.
  assert.match(list.text, new RegExp(`href="/forums/${categoryId}\\?portal=teacher"`));

  const category = await request(app).get(`/forums/${categoryId}?portal=teacher`).set('Cookie', dual.cookie);
  assert.equal(category.status, 200);
  assert.match(category.text, /<p class="portal-nav-title">Co-op Teacher Portal<\/p>/);
  assert.match(category.text, new RegExp(`href="/forums/${categoryId}/new\\?portal=teacher"`));

  const newThreadPage = await request(app).get(`/forums/${categoryId}/new?portal=teacher`).set('Cookie', dual.cookie);
  assert.equal(newThreadPage.status, 200);
  assert.match(newThreadPage.text, /<p class="portal-nav-title">Co-op Teacher Portal<\/p>/);
  const csrfToken = extractCsrf(newThreadPage.text);

  const createRes = await request(app)
    .post(`/forums/${categoryId}/threads?portal=teacher`)
    .set('Cookie', dual.cookie)
    .type('form')
    .send({ title: 'From Co-op Teacher Portal', body: '<p>Hi</p>', _csrf: csrfToken });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.location, /\?portal=teacher$/);

  const threadView = await request(app).get(createRes.headers.location).set('Cookie', dual.cookie);
  assert.equal(threadView.status, 200);
  // This is the exact page that, before the fix, fell back to Parent
  // Portal for a dual-role account once the ?portal=teacher tag was
  // lost navigating from the list into a thread.
  assert.match(threadView.text, /<p class="portal-nav-title">Co-op Teacher Portal<\/p>/);
});

test('without the ?portal=teacher tag, a dual-role account still defaults to Parent Portal (unchanged priority)', async () => {
  const dual = await createDualRoleAccount();

  const list = await request(app).get('/forums').set('Cookie', dual.cookie);
  assert.equal(list.status, 200);
  assert.match(list.text, /<p class="portal-nav-title">Parent Portal<\/p>/);
});

test('Co-op Teacher Portal Training nav link points at /teacher/training, not the bare shared /training picker', async () => {
  const dual = await createDualRoleAccount();
  const home = await request(app).get('/teacher').set('Cookie', dual.cookie);
  assert.equal(home.status, 200);
  assert.match(home.text, /href="\/teacher\/training"/);
});

test('GET /teacher/training stays in the Co-op Teacher Portal shell and auto-resolves the signed-in teacher - no anonymous name picker', async () => {
  const dual = await createDualRoleAccount();
  const res = await request(app).get('/teacher/training').set('Cookie', dual.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<p class="portal-nav-title">Co-op Teacher Portal<\/p>/);
  assert.match(res.text, /<h1>Training<\/h1>/);
  // The anonymous picker's own "pick your name" prompt must never show
  // for an already-identified signed-in account.
  assert.doesNotMatch(res.text, /pick your name/i);
});

// Coverage for a separate real request: "Add description under each
// portal title. On choose portal page..." with the user's own exact
// wording per portal (db/bootstrapPg.js's own PORTAL_ROLES).
test('the choose-portal page shows the exact requested description under each portal title', async () => {
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Multi Role Member', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  const email = 'multi-role-switcher@example.com';
  const password = 'testpassword123';
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword(password))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal' });
  const res = await request(app).get('/portal').set('Cookie', loginRes.headers['set-cookie']);
  assert.equal(res.status, 200);
  assert.match(res.text, /<span class="portal-picker-description">Class registration, event registration, family homeschool management, etc\.<\/span>/);
  assert.match(res.text, /<span class="portal-picker-description">Attendance, manage classes\. Lesson plans\. Etc\.<\/span>/);
});

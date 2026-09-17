// A real request: "all members should already have a portal account."
// createParentMember (utils/memberIntake.js, shared by Main Admin's own
// New Member form, Co-op Admin's New Member form, and the admin-gated
// Membership Form) now calls utils/portalAuth.js's own
// ensurePortalAccountForMember right after creating the parent - the same
// active-status/changeme123-password/skip-if-no-email-or-email-taken
// policy routes/main-admin-members.js's own one-shot /bulk-create-
// accounts already established, just applied automatically at creation
// time from here on, instead of needing that bulk pass run again for
// every new member.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `auto-portal-account-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `auto-portal-account-test-uploads-${process.pid}`);
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
const { verifyPassword } = require('../utils/portalAuth');

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
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members/new').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('a new parent added via Main Admin\'s New Member form gets an active portal account automatically, password "changeme123"', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'Auto Account Family',
      'parents[0][name]': 'Auto Account Parent',
      'parents[0][email]': 'auto-account-parent@example.com',
      'children[0][name]': 'Auto Account Kid',
      _csrf: csrfToken,
    });

  const member = await db.prepare("SELECT id FROM members WHERE name = 'Auto Account Parent'").get();
  assert.ok(member, 'the parent should have been created');

  const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(member.id);
  assert.ok(account, 'a portal account should already exist for this brand-new member - no separate bulk-create step needed');
  assert.equal(account.status, 'active');
  assert.equal(account.email, 'auto-account-parent@example.com');
  assert.ok(await verifyPassword(account, 'changeme123'), 'the starting password should be changeme123, same as the bulk-create pass');
});

test('a new parent with no email on the New Member form gets no account, and creation still succeeds', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'No Email Family',
      'parents[0][name]': 'No Email Parent',
      'children[0][name]': 'No Email Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const member = await db.prepare("SELECT id FROM members WHERE name = 'No Email Parent'").get();
  assert.ok(member, 'the member should still be created even with no email to give an account');
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(member.id);
  assert.equal(account, undefined);
});

test('Co-op Admin\'s own New Member form also auto-creates an account (createdByAccountId simply left blank there)', async () => {
  const { cookie, csrfToken } = await loginAsCoopAdmin();
  await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'Coop Admin Auto Account Family',
      'parents[0][name]': 'Coop Auto Account Parent',
      'parents[0][email]': 'coop-auto-account-parent@example.com',
      'children[0][name]': 'Coop Auto Account Kid',
      _csrf: csrfToken,
    });

  const member = await db.prepare("SELECT id FROM members WHERE name = 'Coop Auto Account Parent'").get();
  assert.ok(member);
  const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(member.id);
  assert.ok(account, 'Co-op Admin\'s own New Member form should get the same auto-account behavior');
  assert.equal(account.status, 'active');
  assert.equal(account.approved_by_account_id, null, 'no Main Admin portal account exists in this flow to attribute it to');
});

test('a duplicate email (already used by another account) is silently skipped, not an error, same as bulk-create', async () => {
  const { cookie: mainCookie, csrfToken: mainCsrf } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', mainCookie)
    .type('form')
    .send({
      newFamilyName: 'First Dup Family',
      'parents[0][name]': 'First Dup Parent',
      'parents[0][email]': 'dup-account@example.com',
      'children[0][name]': 'First Dup Kid',
      _csrf: mainCsrf,
    });

  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'Second Dup Family',
      'parents[0][name]': 'Second Dup Parent',
      'parents[0][email]': 'dup-account@example.com',
      'children[0][name]': 'Second Dup Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302, 'member creation itself should still succeed even though the account is skipped');

  const secondMember = await db.prepare("SELECT id FROM members WHERE name = 'Second Dup Parent'").get();
  assert.ok(secondMember);
  const secondAccount = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(secondMember.id);
  assert.equal(secondAccount, undefined, 'the second member sharing an already-used email should not get a second account');
});

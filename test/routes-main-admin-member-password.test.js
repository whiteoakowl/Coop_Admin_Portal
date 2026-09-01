// Real HTTP-level coverage for a real request: "No creating users. All
// Members should already have an account. Each member profile should
// have a space for password." The standalone "Create Account" page
// (/main-admin/users/new) is gone; a portal account is now created (or
// its password changed) directly from the member's own profile
// (routes/main-admin-members.js's POST /:id/edit).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-member-password-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-member-password-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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
  return { cookie };
}

// A later request: "make every member a user... take away user
// settings." The standalone Users settings tab (account list, role
// editor, and its own now-doubly-defunct "Create Account" page) is gone
// entirely - see test/routes-main-admin-settings-tabs-users-removed.test.js
// for coverage of that removal. This file just keeps covering the
// per-member password flow that replaced it.

test('setting a password on a member with no account creates one', async (t) => {
  const { cookie } = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, email) VALUES ('Password Test Parent', 'Password Test Parent', 'parent', 'passwordtest@example.com')")
    .run();

  await t.test('the edit form offers a password field and no roles-only gate', async () => {
    const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /name="password"/);
    assert.match(res.text, /No portal account yet/);
  });

  await t.test('a password under 8 characters is rejected, no account created', async () => {
    const page = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Password Test Parent', memberType: 'parent', email: 'passwordtest@example.com', password: 'short', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
    assert.equal(account, undefined);
  });

  await t.test('a valid password creates the account using the member\'s email', async () => {
    const page = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Password Test Parent', memberType: 'parent', email: 'passwordtest@example.com', password: 'longenoughpw', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.doesNotMatch(res.headers.location, /error=/);

    const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
    assert.ok(account, 'an account should now exist');
    assert.equal(account.email, 'passwordtest@example.com');
    assert.equal(account.status, 'active');
    assert.ok(await verifyPassword(account, 'longenoughpw'));
  });

  await t.test('the edit form now shows the account and a blank-keeps-current password field', async () => {
    const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Account: passwordtest@example\.com/);
    assert.match(res.text, /leave blank to keep the current one/i);
  });

  await t.test('leaving the password field blank on a later save does not change the existing password', async () => {
    const page = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    await request(app)
      .post(`/main-admin/members/${memberId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Password Test Parent', memberType: 'parent', email: 'passwordtest@example.com', phone: '555-9999', _csrf: csrfToken });

    const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
    assert.ok(await verifyPassword(account, 'longenoughpw'), 'the original password should still work');
    const member = await db.prepare('SELECT phone FROM members WHERE id = ?').get(memberId);
    assert.equal(member.phone, '555-9999');
  });

  await t.test('setting a new password on an existing account changes it', async () => {
    const page = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    await request(app)
      .post(`/main-admin/members/${memberId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Password Test Parent', memberType: 'parent', email: 'passwordtest@example.com', password: 'brandnewpassword', _csrf: csrfToken });

    const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
    assert.ok(await verifyPassword(account, 'brandnewpassword'));
    assert.equal(await verifyPassword(account, 'longenoughpw'), false, 'the old password should no longer work');
  });
});

test('setting a password without an email on file is rejected', async () => {
  const { cookie } = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Email Member', 'No Email Member', 'parent')")
    .run();

  const page = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  const res = await request(app)
    .post(`/main-admin/members/${memberId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'No Email Member', memberType: 'parent', password: 'longenoughpw', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  const account = await db.prepare('SELECT * FROM member_accounts WHERE member_id = ?').get(memberId);
  assert.equal(account, undefined);
});

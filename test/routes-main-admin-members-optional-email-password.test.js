// Coverage for a real request: "all member forms. Student should have
// an email request and password request line, not mandatory. Each
// parent should have an email and password text boxes as well." Both
// optional, but a short password is rejected, and setting one with no
// email to log in with makes no sense (routes/main-admin-members.js's
// own POST /new, shared validation shape with routes/membership.js's
// own POST /membership).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-optional-pw-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-optional-pw-test-uploads-${process.pid}`);
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

test('the Add Member form has optional Email/Password boxes for both the parent and the student', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /name="parents\[0\]\[password\]"/);
  assert.match(res.text, /name="children\[0\]\[email\]"/);
  assert.match(res.text, /name="children\[0\]\[password\]"/);
  // Neither is marked required - these are optional per the real request.
  assert.doesNotMatch(res.text, /name="children\[0\]\[email\]"[^>]*required/);
  assert.doesNotMatch(res.text, /name="children\[0\]\[password\]"[^>]*required/);
});

test('a parent password under 8 characters is rejected with no members created', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'ShortPasswordFamily',
      'parents[0][name]': 'Short Password Parent',
      'parents[0][email]': 'short.password@example.com',
      'parents[0][password]': 'short1',
      'children[0][name]': 'Short Password Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  const member = await db.prepare("SELECT id FROM members WHERE name = 'Short Password Parent'").get();
  assert.equal(member, undefined);
});

test('a password with no email to log in with is rejected', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'NoEmailPasswordFamily',
      'parents[0][name]': 'No Email Password Parent',
      'parents[0][password]': 'longenoughpw1',
      'children[0][name]': 'No Email Password Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  const member = await db.prepare("SELECT id FROM members WHERE name = 'No Email Password Parent'").get();
  assert.equal(member, undefined);
});

test('a valid parent+student email/password creates portal accounts with the typed-in password, not the default', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'ValidPasswordFamily',
      'parents[0][name]': 'Valid Password Parent',
      'parents[0][email]': 'valid.password.parent@example.com',
      'parents[0][password]': 'parentpassword1',
      'children[0][name]': 'Valid Password Kid',
      'children[0][email]': 'valid.password.kid@example.com',
      'children[0][password]': 'kidpassword123',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const parentAccount = await db.prepare("SELECT password_hash FROM member_accounts WHERE LOWER(email) = 'valid.password.parent@example.com'").get();
  assert.ok(parentAccount);
  assert.ok(await verifyPassword(parentAccount, 'parentpassword1'));
  assert.ok(!(await verifyPassword(parentAccount, 'changeme123')));

  const kidAccount = await db.prepare("SELECT password_hash FROM member_accounts WHERE LOWER(email) = 'valid.password.kid@example.com'").get();
  assert.ok(kidAccount, 'a student with an email should get its own portal account');
  assert.ok(await verifyPassword(kidAccount, 'kidpassword123'));
});

test('a student with no email gets no portal account at all - a login is never silently created for them', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'NoEmailKidFamily',
      'parents[0][name]': 'No Email Kid Parent',
      'parents[0][email]': 'no.email.kid.parent@example.com',
      'children[0][name]': 'No Email Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const kid = await db.prepare("SELECT id FROM members WHERE name = 'No Email Kid'").get();
  assert.ok(kid);
  const kidAccount = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(kid.id);
  assert.equal(kidAccount, undefined);
});

// Coverage for the public self-registration form (routes/portal-auth.js's
// GET/POST /register, views/portal-register.ejs) - a real request: "there
// should be a place at the bottom of the membership application to check
// a box after reading the policy handbook... can't submit application
// without checking the box." The client-side scroll-gating (public/js/
// portal-register-form.js disables the checkbox until scrolled to the
// bottom) isn't testable at the route level, but the server-side
// re-check (a disabled attribute is only ever a client-side nicety) is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-register-membership-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-register-membership-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const membershipHandbook = require('../utils/membershipHandbook');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function baseRegistration(overrides) {
  return {
    firstName: 'Pat',
    lastName: 'Applicant',
    email: 'pat.applicant@example.com',
    password: 'testpassword123',
    confirmPassword: 'testpassword123',
    handbookRead: '1',
    ...overrides,
  };
}

test('GET /register renders the admin-set Policy Handbook and payment info', async () => {
  await membershipHandbook.setHandbookHtml('<p>Read this whole handbook.</p>');
  await membershipHandbook.setPaymentInfo(15000, 'Pay by check once approved.');

  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, /Read this whole handbook/);
  assert.match(res.text, /150\.00/);
  assert.match(res.text, /Pay by check once approved/);
});

test('POST /register without handbookRead=1 is rejected, no account created', async () => {
  const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c);
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ handbookRead: undefined, email: 'no-handbook@example.com' }));
  assert.equal(res.status, 200);
  assert.match(res.text, /Policy Handbook/);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM member_accounts').get()).c), before);
});

test('POST /register with handbookRead=1 succeeds, creating a pending account', async () => {
  const res = await request(app)
    .post('/register')
    .type('form')
    .send(baseRegistration({ email: 'handbook-confirmed@example.com' }));
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const account = await db.prepare("SELECT status FROM member_accounts WHERE email = 'handbook-confirmed@example.com'").get();
  assert.ok(account, 'expected a member_accounts row to be created');
  assert.equal(account.status, 'pending');
});

// Coverage for the Main Admin Portal > Members > Settings tab's new
// Policy Handbook and Membership Fee & Payment sections (routes/main-
// admin-members.js's POST /settings/handbook and /settings/payment) - a
// real request: "there should be a place at the bottom of the membership
// application to check a box after reading the policy handbook... place
// at the bottom of the application for payment." What's saved here is
// what the public /register form (views/portal-register.ejs) shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-handbook-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-handbook-test-uploads-${process.pid}`);
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('POST /main-admin/members/settings/handbook saves sanitized HTML shown on the public application', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/settings/handbook')
    .set('Cookie', cookie)
    .type('form')
    .send({ handbookHtml: '<p>Be kind. <script>alert(1)</script></p>', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const settingsPage = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.match(settingsPage.text, /Be kind\./);
  assert.doesNotMatch(settingsPage.text, /<script>alert/);

  const publicForm = await request(app).get('/register');
  assert.match(publicForm.text, /Be kind\./);
});

test('POST /main-admin/members/settings/payment saves the fee and instructions, shown on the public application', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/settings/payment')
    .set('Cookie', cookie)
    .type('form')
    .send({ feeDollars: '125.00', instructions: 'Pay by Venmo @coop once approved.', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const publicForm = await request(app).get('/register');
  assert.match(publicForm.text, /125\.00/);
  assert.match(publicForm.text, /Pay by Venmo @coop once approved\./);
});

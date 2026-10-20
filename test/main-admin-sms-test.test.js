// Coverage for a real request: "Do a test page to find the problem
// quickly" - a Main-Admin-only diagnostic page that calls
// utils/smsProvider.send() directly and shows the exact {status,
// detail} it returns, bypassing notify()/the notification_deliveries
// table entirely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-sms-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-sms-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('the SMS test page shows configuration status and is Main-Admin-only', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/announcements/text/sms-test').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /SMS Test/);
  assert.match(page.text, /NOT configured/, 'no Telnyx env vars are set in this test environment');

  const loggedOut = await request(app).get('/main-admin/announcements/text/sms-test');
  assert.equal(loggedOut.status, 302);
  assert.match(loggedOut.headers.location, /^\/login/);
});

test('submitting a test send with no Telnyx configured shows the exact skipped status and detail, never a fake "sent"', async () => {
  const cookie = await loginAsMainAdmin();
  const csrfPage = await request(app).get('/main-admin/announcements/text/sms-test').set('Cookie', cookie);
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(csrfPage.text)[1];

  const res = await request(app)
    .post('/main-admin/announcements/text/sms-test')
    .set('Cookie', cookie)
    .type('form')
    .send({ phone: '555-123-4567', message: 'Hello', _csrf: csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /badge-pill-gray">skipped/);
  assert.match(res.text, /No SMS provider configured/);
});

test('submitting with no phone number shows the "no phone number on file" detail', async () => {
  const cookie = await loginAsMainAdmin();
  const csrfPage = await request(app).get('/main-admin/announcements/text/sms-test').set('Cookie', cookie);
  const csrf = /name="csrf-token" content="([^"]*)"/.exec(csrfPage.text)[1];

  const res = await request(app)
    .post('/main-admin/announcements/text/sms-test')
    .set('Cookie', cookie)
    .type('form')
    .send({ phone: '', message: 'Hello', _csrf: csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /No phone number on file/);
});

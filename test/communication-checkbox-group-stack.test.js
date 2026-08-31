// Real bug report: "main admin and co-op admin, communication, mobile
// view. checkboxes for who to send it to should all be stacked in a clean
// column to the left." The "Send to" checkbox group on the Announcements
// composer (Co-op Admin /admin/announcements and Main Admin
// /main-admin/announcements) wraps into a ragged row layout on narrow
// screens since its labels vary a lot in length ("Everyone (all active
// members)" vs a bare role name). Fixed with a new checkbox-group-stack
// modifier class (public/css/styles.css) that switches to a single
// left-aligned column under a 640px media query, without touching the
// shared .checkbox-group class the kiosk Name Tag / Absence forms also
// use. This suite has no browser/CSS layout harness, so it can only
// assert the markup wiring is present.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `communication-checkbox-group-stack-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `communication-checkbox-group-stack-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin Announcements "Send to" checkbox group carries the stack modifier class', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/announcements').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="checkbox-group checkbox-group-stack">/);
  assert.match(res.text, /Everyone \(all active members\)/);
});

test('Main Admin Announcements "Send to" checkbox group carries the stack modifier class', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="checkbox-group checkbox-group-stack">/);
  assert.match(res.text, /Everyone \(all active members\)/);
});

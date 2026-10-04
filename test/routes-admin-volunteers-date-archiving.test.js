// Floater Assignments' Archive tab/button were removed (nothing moves a
// session date off the manage page's own Choose Date dropdown anymore,
// unlike Setup/Cleanup's always-auto-hide-past-dates behavior) - this
// just guards that a date stays selectable regardless of how far in the
// past it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-date-archiving-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-date-archiving-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function addDate(cookie, csrfToken, day, date) {
  await request(app).post(`/admin/volunteers/${day}/dates/add`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken, dates: date });
}

test('a date in the past still shows on the manage page\'s Choose Date dropdown', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const pastDate = '2020-01-06'; // a real past Monday
  await addDate(cookie, csrfToken, 'monday', pastDate);

  const res = await request(app).get(`/admin/volunteers/monday/manage?date=${pastDate}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  const selectHtml = /<select id="chart-date-select"[\s\S]*?<\/select>/.exec(res.text)[0];
  assert.match(selectHtml, new RegExp(`value="${pastDate}"[^>]*selected`), 'a past date should still be selectable - Floater Assignments has no auto-hide-by-date behavior');
});

test('Floater Assignments has no Archive tab/button anymore', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /\/admin\/volunteers\/monday\/archive/, 'no link to the removed Archive feature should remain');

  assert.equal((await request(app).get('/admin/volunteers/monday/archive').set('Cookie', cookie)).status, 404);
  assert.equal((await request(app).get('/admin/volunteers/monday/archive/2020-01-06/view-fragment').set('Cookie', cookie)).status, 404);
  assert.equal((await request(app).get('/admin/volunteers/monday/archive/2020-01-06/print').set('Cookie', cookie)).status, 404);
  assert.equal((await request(app).get('/admin/volunteers/monday/archive/2020-01-06/export.csv').set('Cookie', cookie)).status, 404);
});

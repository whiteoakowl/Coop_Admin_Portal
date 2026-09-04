// Real request: "co-op admin portal, Wednesday/Monday attendance. have it
// land on the parent roster each time you click the attendance tab.
// currently it always lands on student roster." The sidebar's own
// Attendance link (partials/admin-nav.ejs) has no ?tab= at all, so this is
// specifically about the GET /admin/rosters route's own fallback when no
// tab (or day, since /admin/rosters?tab=monday-student is what the top
// Monday/Wednesday pills themselves link to - see admin-rosters.ejs) was
// requested at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-default-tab-parent-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-default-tab-parent-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('GET /admin/rosters with no ?tab= at all lands on the Parent roster, not Student', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/rosters').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Parents Attendance/);
  assert.doesNotMatch(res.text, /Students Attendance/);
});

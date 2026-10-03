// A real request: "Co-op admin portal, attendance, Monday, it should
// always land on parents first." The Attendance nav's own Wednesday
// subpage link already pointed at ?tab=wednesday-parent (a prior real
// request); Monday's own link still pointed at ?tab=monday-student,
// unchanged since then. This made both days consistent - fixed Monday/
// Wednesday links were later replaced by one bare "Parent/Student
// Rosters" link (the 7-day expansion's own Phase 3: Day Settings can now
// activate any day of the week, not just Monday/Wednesday, so the nav
// can't hardcode a link per day anymore), which relies on the same
// behavior a different way: GET /admin/rosters with no ?tab= at all
// (routes/admin-rosters.js's own defaultDay fallback) still always lands
// on that day's Parent half, never Student.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-nav-attendance-monday-parent-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-nav-attendance-monday-parent-test-uploads-${process.pid}`);
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

test('Attendance nav: the Parent/Student Rosters subpage link lands on the Parent roster first', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin').set('Cookie', cookie);
  assert.match(page.text, /href="\/admin\/rosters">Parent\/Student Rosters</);

  const rostersPage = await request(app).get('/admin/rosters').set('Cookie', cookie);
  assert.match(rostersPage.text, /Parents Attendance/);
  assert.doesNotMatch(rostersPage.text, /Students Attendance/);
});

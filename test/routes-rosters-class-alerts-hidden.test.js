// Real HTTP-level coverage: the Attendance page's "<Day> Alerts" section
// (Absence Forms / Late Forms / Class Cancellation Risk / Substitutes
// Needed, views/admin-rosters.ejs) belongs to the day-level Parent/Student
// rosters only - a single class's roster view shouldn't repeat the same
// whole-day alert log below its own attendance table.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `rosters-class-alerts-hidden-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `rosters-class-alerts-hidden-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const { createClass } = require('../utils/classSchedule');

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

test('the day-level Parent/Student roster still shows the Alerts section', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Monday Alerts/);
  assert.match(res.text, /Substitutes Needed/);
});

test('a single class roster does NOT show the Alerts section', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Alerts Visibility Test Class' });

  const res = await request(app).get(`/admin/rosters?tab=class-${classId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Monday Alerts/);
  assert.doesNotMatch(res.text, /Substitutes Needed/);
  assert.doesNotMatch(res.text, /Class Cancellation Risk/);
});

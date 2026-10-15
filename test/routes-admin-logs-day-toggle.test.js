// Real HTTP-level coverage for a bug report this session ("all toggles on
// pages are wrong"): the Logs page's Class Cancellation Risk and
// Substitutes Needed tabs used a bare "Viewing Monday"/"Viewing
// Wednesday" <select> for their day switcher instead of the pill
// .day-toggle every other day-switching page in the app uses (Schedules,
// Setup/Cleanup, Floater Teams, Attendance) - inconsistent, and the one
// concrete "should be a toggle" instance the investigation into that bug
// report turned up (alongside the now-deleted admin-class-schedule.ejs
// duplicate page, covered by test/routes-class-schedule-tabs.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-logs-day-toggle-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-logs-day-toggle-test-uploads-${process.pid}`);
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

// A real request rebuilt this tab entirely into a by-date log with a
// running per-class risk tally (routes/admin-logs.js's own
// classCancellationRiskRows) - the day-of-week picker this test
// originally covered is gone (a class is now identified by name/date,
// not by which weekday tab you happened to have open), replaced by a
// Date/Class filter-mode toggle that reuses the exact same pill
// .day-toggle/.day-toggle-option markup this test already asserted on,
// just switching filterBy instead of day.
test('Logs: Class Cancellation Risk tab uses a pill toggle to switch between Date and Class filtering', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs?tab=classrisk').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="day-toggle"/);
  assert.match(res.text, /href="\/admin\/logs\?tab=classrisk&amp;filterBy=date"/);
  assert.match(res.text, /href="\/admin\/logs\?tab=classrisk&amp;filterBy=class"/);
});

test('Logs: Substitutes Needed tab uses the pill day-toggle and preserves the date filter across days', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs?tab=substitutes&day=monday&date=2026-01-07').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="day-toggle"/);
  assert.doesNotMatch(res.text, /<select onchange="window\.location = '\/admin\/logs\?tab=substitutes/);
  assert.match(res.text, /href="\/admin\/logs\?tab=substitutes&amp;day=wednesday&amp;date=2026-01-07"/, 'switching days should carry the current date filter along');
});

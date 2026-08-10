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

function assertDayToggle(html, basePath) {
  assert.match(html, /class="day-toggle"/, 'expected the shared pill day-toggle, not a bare <select>');
  assert.doesNotMatch(html, /id="day-select"/, 'the old "Viewing Monday/Wednesday" <select> should be gone');
  assert.match(html, new RegExp(`class="day-toggle-option active" href="${basePath}&day=monday`));
}

test('Logs: Class Cancellation Risk tab uses the pill day-toggle', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs?tab=classrisk').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assertDayToggle(res.text, '/admin/logs\\?tab=classrisk');
});

test('Logs: Substitutes Needed tab uses the pill day-toggle and preserves the date filter across days', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs?tab=substitutes&day=monday&date=2026-01-07').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="day-toggle"/);
  assert.doesNotMatch(res.text, /<select onchange="window\.location = '\/admin\/logs\?tab=substitutes/);
  assert.match(res.text, /href="\/admin\/logs\?tab=substitutes&amp;day=wednesday&amp;date=2026-01-07"/, 'switching days should carry the current date filter along');
});

// A real request: "the alert log should be the same as the daily alert
// log on the bottom of the attendance page, showing absent, late, class
// cancelation risk, substitutes needed. exactly the same." Home
// dashboard's Alert Log (routes/admin.js's GET /) now reads the exact
// same shared functions (utils/alerts.js's absenceFormSubmissionsForRoster)
// the Attendance page's own inline Alerts box already used (see
// test/routes-rosters-class-alerts-hidden.test.js), so both surfaces stay
// in sync automatically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-dashboard-alert-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-dashboard-alert-log-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, weekdayOf } = require('../utils/dates');

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

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };
// A calendar date is only ever one weekday, so this is at most one day -
// unlike the future-dated tests elsewhere in this suite, using TODAY's
// own real weekday to pick which day's roster to seed is never stale: on
// any given run, it's always asking the exact same "is today a session
// day" question routes/admin.js's own GET / asks with the exact same
// real today, so it's correct on whichever real day this suite happens
// to run.
function todaysSessionDay() {
  const today = todayISO();
  return Object.keys(DAY_WEEKDAY).find((day) => weekdayOf(today) === DAY_WEEKDAY[day]) || null;
}

test('the Home dashboard Alert Log always shows all 4 Attendance-page section headings', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Alert Log/);
  assert.match(res.text, /Absence Forms/);
  assert.match(res.text, /Late Forms/);
  assert.match(res.text, /Class Cancellation Risk/);
  assert.match(res.text, /Substitutes Needed/);
});

test('an absence/late form submitted today shows up on the dashboard Alert Log exactly like the Attendance page\'s own Alerts box', async (t) => {
  const day = todaysSessionDay();
  if (!day) {
    t.skip('today is not a Monday/Wednesday session day in this environment');
    return;
  }
  const today = todayISO();
  const cookie = await loginAsAdmin();

  const roster = await db.prepare(`SELECT id FROM rosters WHERE name = ?`).get(day === 'monday' ? 'Monday Parents' : 'Wednesday Parents');
  const { lastInsertRowid: absentParentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dashboard Alert Absent Parent', 'dashboard-alert-absent-parent', 'parent')")
    .run();
  const { lastInsertRowid: lateParentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dashboard Alert Late Parent', 'dashboard-alert-late-parent', 'parent')")
    .run();
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category) VALUES (?, ?, ?, 'absent', 'absence_form', 'medical')")
    .run(absentParentId, roster.id, today);
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source, reason_category) VALUES (?, ?, ?, 'late', 'absence_form', 'personal')")
    .run(lateParentId, roster.id, today);

  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`&mdash; ${day === 'monday' ? 'Monday' : 'Wednesday'}`), 'the Alert Log heading should name today\'s actual session day');
  assert.match(res.text, /Dashboard Alert Absent Parent/);
  assert.match(res.text, /Dashboard Alert Late Parent/);
});

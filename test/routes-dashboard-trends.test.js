// Real HTTP-level coverage for the Home dashboard's "Today's Attendance"
// card (routes/admin.js's statsWithTrends() + views/admin-dashboard.ejs's
// .attendance-status-row markup). A real request, with a reference
// screenshot, replaced the old KPI-trend-badge stat grid (views/
// partials/dashboard-type-stats.ejs, no longer rendered from this page)
// with plain Checked In/Out/Absent/Late counts and no up/down trend
// indicators - so this file no longer asserts on trend-badge markup, just
// that the day-level counts themselves stay correct. Boots the real app
// (server.js) against a throwaway DB, same pattern as the other
// test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-dashboard-trends-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-dashboard-trends-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

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

// Pulls the numeric "Checked In" value shown for the named member type
// (e.g. "Students") from the rendered dashboard's Today's Attendance card.
function checkedInCountFor(html, memberTypeLabel) {
  const row = /attendance-status-row-checkedin"[\s\S]*?<\/a>/.exec(html);
  if (!row) return null;
  const match = new RegExp(`${memberTypeLabel}</span>\\s*<span class="attendance-status-count-value">(\\d+)`).exec(row[0]);
  return match ? parseInt(match[1], 10) : null;
}

test('dashboard Today\'s Attendance counts', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('the Today\'s Attendance card renders no KPI trend badges (superseded by the plain status-row design)', async () => {
    const res = await request(app).get('/admin').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /trend-badge/);
  });

  await t.test('a member present or checked out only on a class roster does not inflate the day-level count', async () => {
    const today = todayISO();
    const before = await request(app).get('/admin').set('Cookie', cookie);
    const checkedInBefore = checkedInCountFor(before.text, 'Students');

    const classRosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Isolation Test Class Roster', 'Class Roster')").run()).lastInsertRowid;
    const memberId = (await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class Only Dashboard Kid', 'class-only-dashboard-kid', 'student')")
      .run()).lastInsertRowid;
    await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'present', 'kiosk_class_checkin')").run(
      memberId,
      classRosterId,
      today
    );
    await db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, NULL, ?)').run(
      memberId,
      classRosterId,
      today,
      Date.now()
    );

    const after = await request(app).get('/admin').set('Cookie', cookie);
    const checkedInAfter = checkedInCountFor(after.text, 'Students');
    assert.equal(checkedInAfter, checkedInBefore, 'a class-roster-only present status must not change the day-level Checked In count');
  });
});

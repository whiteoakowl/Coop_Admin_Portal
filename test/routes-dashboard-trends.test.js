// Real HTTP-level coverage for the Home dashboard's KPI trend indicators
// (Phase 4 audit item #76, routes/admin.js's statsWithTrends() +
// views/partials/dashboard-type-stats.ejs). The one thing worth pinning
// down at the route level rather than just trusting the pure
// utils/dashboardTrends.js unit tests: a brand-new co-op with no prior
// session must render with NO trend badges at all, not a misleading
// comparison against a session that never happened. Boots the real app
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

// Pulls the numeric "Checked In" value shown under the named stats card
// (e.g. "Students") from the rendered dashboard HTML.
function checkedInCountFor(html, cardLabel) {
  const afterHeading = html.slice(html.indexOf(`<h2>${cardLabel}</h2>`));
  const match = /analytics-stat-checkedin">[\s\S]*?analytics-stat-value">(\d+)/.exec(afterHeading);
  return match ? parseInt(match[1], 10) : null;
}

test('dashboard KPI trend indicators', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('with no prior session, the dashboard renders no trend badges at all', async () => {
    const res = await request(app).get('/admin').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /trend-badge/);
  });

  await t.test('once a prior session exists, matching stat changes render the right direction and delta', async () => {
    const insertMember = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')");
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      ids.push(insertMember.run(`Dashboard Trend Kid ${i}`, `dashboard-trend-kid-${i}`).lastInsertRowid);
    }

    const prevDate = '2020-01-06';
    const today = todayISO();

    // Previous session: 1 present, 1 late.
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, 2, ?, 'present', 'kiosk')").run(ids[0], prevDate);
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, 2, ?, 'late', 'kiosk')").run(ids[1], prevDate);

    // Today: 3 present (checked-in up from 1 to 3), 0 late (down from 1 to 0).
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, 2, ?, 'present', 'kiosk')").run(ids[0], today);
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, 2, ?, 'present', 'kiosk')").run(ids[1], today);
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, 2, ?, 'present', 'kiosk')").run(ids[2], today);

    const res = await request(app).get('/admin').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /trend-badge trend-badge-up[^>]*>[\s\S]*?\+2/, 'checked-in should show up +2');
    assert.match(res.text, /trend-badge trend-badge-down[^>]*>[\s\S]*?-1/, 'late should show down -1');
    assert.match(res.text, /vs last session \(Mon 1\/6\)/, 'previous session date shown in the tooltip');
  });

  await t.test('a member present or checked out only on a class roster does not inflate the day-level count', async () => {
    const today = todayISO();
    const before = await request(app).get('/admin').set('Cookie', cookie);
    const checkedInBefore = checkedInCountFor(before.text, 'Students');

    const classRosterId = db.prepare("INSERT INTO rosters (name, category) VALUES ('Isolation Test Class Roster', 'Class Roster')").run().lastInsertRowid;
    const memberId = db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class Only Dashboard Kid', 'class-only-dashboard-kid', 'student')")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'present', 'kiosk_class_checkin')").run(
      memberId,
      classRosterId,
      today
    );
    db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, NULL, ?)').run(
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

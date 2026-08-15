// Real HTTP-level coverage for the Home dashboard's "Today's Attendance"
// section (routes/admin.js's todayStatsForType()) - the "X of Y" denominator
// must only count members actually expected on today's weekday (those on
// that day's auto-synced Parent/Student roster), not every active member of
// that type. Before this fix, Y was a flat `COUNT(*) FROM members`, so an
// active member who wasn't scheduled at all today still inflated the
// denominator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-dashboard-today-total-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-dashboard-today-total-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, weekdayOf } = require('../utils/dates');
const { ensureDayMemberRosters } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

// Pulls the "of Y" denominator shown under a stats card's "Checked In" row.
function ofTotalFor(html, cardLabel) {
  const afterHeading = html.slice(html.indexOf(`<h2>${cardLabel}</h2>`));
  const match = /analytics-stat-checkedin">[\s\S]*?analytics-stat-of"> of (\d+)/.exec(afterHeading);
  return match ? parseInt(match[1], 10) : null;
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('dashboard "Today\'s Attendance" denominator', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('an active student not scheduled anywhere today does not inflate the denominator', async () => {
    const before = await request(app).get('/admin').set('Cookie', cookie);
    const totalBefore = ofTotalFor(before.text, 'Students');

    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unscheduled Dashboard Kid', 'unscheduled-dashboard-kid', 'student')").run();

    const after = await request(app).get('/admin').set('Cookie', cookie);
    const totalAfter = ofTotalFor(after.text, 'Students');

    assert.equal(totalAfter, totalBefore, 'an unscheduled active student must not change the "of Y" denominator');
  });

  await t.test('a student scheduled on the OTHER meeting day does not inflate today\'s denominator', async () => {
    const dow = weekdayOf(todayISO());
    const todayDay = dow === 1 ? 'monday' : dow === 3 ? 'wednesday' : null;
    const otherDay = todayDay === 'monday' ? 'wednesday' : 'monday';

    const before = await request(app).get('/admin').set('Cookie', cookie);
    const totalBefore = ofTotalFor(before.text, 'Students');

    const rosterIds = await ensureDayMemberRosters();
    const memberId = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Other Day Dashboard Kid', 'other-day-dashboard-kid', 'student')")
        .run()
    ).lastInsertRowid;
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterIds[otherDay].student, memberId);

    const after = await request(app).get('/admin').set('Cookie', cookie);
    const totalAfter = ofTotalFor(after.text, 'Students');

    assert.equal(totalAfter, totalBefore, "a student scheduled only on the other meeting day must not change today's denominator");
  });

  await t.test('a student scheduled on TODAY\'s roster increases the denominator by 1 (only on an actual meeting day)', async (t) => {
    const dow = weekdayOf(todayISO());
    const todayDay = dow === 1 ? 'monday' : dow === 3 ? 'wednesday' : null;
    if (!todayDay) {
      t.skip('the co-op does not meet today, so there is no day-level roster to add to');
      return;
    }

    const before = await request(app).get('/admin').set('Cookie', cookie);
    const totalBefore = ofTotalFor(before.text, 'Students');

    const rosterIds = await ensureDayMemberRosters();
    const memberId = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Today Roster Dashboard Kid', 'today-roster-dashboard-kid', 'student')")
        .run()
    ).lastInsertRowid;
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterIds[todayDay].student, memberId);

    const after = await request(app).get('/admin').set('Cookie', cookie);
    const totalAfter = ofTotalFor(after.text, 'Students');

    assert.equal(totalAfter, totalBefore + 1, "a student scheduled on today's roster should count toward today's denominator");
  });
});

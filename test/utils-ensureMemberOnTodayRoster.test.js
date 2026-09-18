// Real coverage for utils/rosters.js's ensureMemberOnTodayRoster - a real
// request: "even if a member doesn't have a schedule they should still
// be able to check in and out and they will automatically be added to
// the roster for that day." routes/kiosk.js's /checkin/scan and routes/
// checkout.js's /checkout/scan both call this only when a member has no
// roster for today, then re-query - covered end to end there for
// whatever real weekday the suite happens to run on (see those tests'
// own comments). This calls it directly with an explicit date instead,
// so the Monday/Wednesday branch gets exercised regardless of which day
// that is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `ensure-member-on-today-roster-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `ensure-member-on-today-roster-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const app = require('../server');
const db = require('../db');
const { ensureMemberOnTodayRoster } = require('../utils/rosters');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function onDayRoster(memberId, day, category = 'Class Schedule') {
  return db
    .prepare(
      `SELECT 1 FROM roster_members rm JOIN rosters r ON r.id = rm.roster_id
       WHERE rm.member_id = ? AND r.schedule_day = ? AND r.category = ?`
    )
    .get(memberId, day, category);
}

test('ensureMemberOnTodayRoster', async (t) => {
  await t.test('adds a student to that day\'s Student roster on a real meeting day (Monday)', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Roster Fallback Student', 'roster-fallback-student', 'student')")
      .run();
    // A real, upcoming Monday - the date's own weekday is all that
    // matters here, not which specific week.
    await ensureMemberOnTodayRoster(member(memberId, 'student'), '2026-06-01');
    assert.ok(await onDayRoster(memberId, 'monday'), 'expected the student on Monday\'s Student roster');
    const dateRow = await db
      .prepare(`SELECT 1 FROM roster_dates rd JOIN rosters r ON r.id = rd.roster_id WHERE r.schedule_day = 'monday' AND r.category = 'Class Schedule' AND rd.session_date = '2026-06-01'`)
      .get();
    assert.ok(dateRow, 'expected 2026-06-01 to have been added as a session date on that roster');
  });

  await t.test('adds a parent to that day\'s Parent roster on a real meeting day (Wednesday)', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Roster Fallback Parent', 'roster-fallback-parent', 'parent')")
      .run();
    await ensureMemberOnTodayRoster(member(memberId, 'parent'), '2026-06-03');
    assert.ok(await onDayRoster(memberId, 'wednesday'), 'expected the parent on Wednesday\'s Parent roster');
  });

  await t.test('an admin shares the Parent roster, same as everywhere else in this app', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Roster Fallback Admin', 'roster-fallback-admin', 'admin')")
      .run();
    await ensureMemberOnTodayRoster(member(memberId, 'admin'), '2026-06-01');
    assert.ok(await onDayRoster(memberId, 'monday'), 'expected the admin on Monday\'s Parent roster (member_type IN (parent, admin))');
  });

  await t.test('is a no-op on a day the co-op does not meet (e.g. a Tuesday)', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Roster Fallback Off Day', 'roster-fallback-off-day', 'student')")
      .run();
    await ensureMemberOnTodayRoster(member(memberId, 'student'), '2026-06-02');
    assert.equal(await onDayRoster(memberId, 'monday'), undefined);
    assert.equal(await onDayRoster(memberId, 'wednesday'), undefined);
  });

  await t.test('is idempotent - calling it twice for the same member/date does not error or duplicate', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Roster Fallback Repeat', 'roster-fallback-repeat', 'student')")
      .run();
    await ensureMemberOnTodayRoster(member(memberId, 'student'), '2026-06-01');
    await ensureMemberOnTodayRoster(member(memberId, 'student'), '2026-06-01');
    const count = Number(
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM roster_members rm JOIN rosters r ON r.id = rm.roster_id
           WHERE rm.member_id = ? AND r.schedule_day = 'monday' AND r.category = 'Class Schedule'`
        )
        .get(memberId)).n
    );
    assert.equal(count, 1);
  });
});

function member(id, member_type) {
  return { id, member_type };
}

// Real coverage for routes/admin.js's todayStatsForType() - the "X of Y"
// denominator must only count members actually expected on today's
// weekday (those on that day's auto-synced Parent/Student roster), not
// every active member of that type. Before this fix, Y was a flat
// `COUNT(*) FROM members`, so an active member who wasn't scheduled at
// all today still inflated the denominator.
//
// The Home dashboard's own "Today's Attendance" card no longer displays
// this denominator anywhere (a real request, with a reference
// screenshot, replaced it with plain Checked In/Out/Absent/Late counts -
// see routes/admin.js's own comment by its `router.todayStatsForType`
// export), so this calls the function directly against the shared db
// instead of scraping HTML for markup that's no longer rendered.
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

const app = require('../server');
const db = require('../db');
const adminRouter = require('../routes/admin');
const { todayISO, weekdayOf } = require('../utils/dates');
const { ensureDayMemberRosters } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('todayStatsForType "of Y" denominator', async (t) => {
  await t.test('an active student not scheduled anywhere today does not inflate the denominator', async () => {
    const today = todayISO();
    const totalBefore = (await adminRouter.todayStatsForType('student', today)).total;

    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unscheduled Dashboard Kid', 'unscheduled-dashboard-kid', 'student')").run();

    const totalAfter = (await adminRouter.todayStatsForType('student', today)).total;
    assert.equal(totalAfter, totalBefore, 'an unscheduled active student must not change the "of Y" denominator');
  });

  await t.test('a student scheduled on the OTHER meeting day does not inflate today\'s denominator', async () => {
    const today = todayISO();
    const dow = weekdayOf(today);
    const todayDay = dow === 1 ? 'monday' : dow === 3 ? 'wednesday' : null;
    const otherDay = todayDay === 'monday' ? 'wednesday' : 'monday';

    const totalBefore = (await adminRouter.todayStatsForType('student', today)).total;

    const rosterIds = await ensureDayMemberRosters();
    const memberId = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Other Day Dashboard Kid', 'other-day-dashboard-kid', 'student')")
        .run()
    ).lastInsertRowid;
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterIds[otherDay].student, memberId);

    const totalAfter = (await adminRouter.todayStatsForType('student', today)).total;
    assert.equal(totalAfter, totalBefore, "a student scheduled only on the other meeting day must not change today's denominator");
  });

  await t.test('a student scheduled on TODAY\'s roster increases the denominator by 1 (only on an actual meeting day)', async (t) => {
    const today = todayISO();
    const dow = weekdayOf(today);
    const todayDay = dow === 1 ? 'monday' : dow === 3 ? 'wednesday' : null;
    if (!todayDay) {
      t.skip('the co-op does not meet today, so there is no day-level roster to add to');
      return;
    }

    const totalBefore = (await adminRouter.todayStatsForType('student', today)).total;

    const rosterIds = await ensureDayMemberRosters();
    const memberId = (
      await db
        .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Today Roster Dashboard Kid', 'today-roster-dashboard-kid', 'student')")
        .run()
    ).lastInsertRowid;
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(rosterIds[todayDay].student, memberId);

    const totalAfter = (await adminRouter.todayStatsForType('student', today)).total;
    assert.equal(totalAfter, totalBefore + 1, "a student scheduled on today's roster should count toward today's denominator");
  });
});

// A later real request: "admins should still count as parents for
// features such as attendance and absence forms... if an admin submits
// an absence form they should still be counted as an absent parent on
// today's count on the homepage." routes/admin.js's own Home dashboard
// route now calls todayStatsForType(['parent', 'admin'], today) for the
// Parent card - todayStatsForType itself accepts either a single type or
// an array, IN-ing every type given.
test('todayStatsForType accepts an array of member types, so an admin\'s absence form counts toward the Parent card\'s "Absent" total', async () => {
  const today = todayISO();
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  const adminId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dashboard Absent Admin', 'dashboard-absent-admin', 'admin')").run()
  ).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'absence_form')")
    .run(adminId, roster.id, today);

  const parentOnly = (await adminRouter.todayStatsForType('parent', today)).absent;
  const parentAndAdmin = (await adminRouter.todayStatsForType(['parent', 'admin'], today)).absent;
  assert.equal(parentAndAdmin, parentOnly + 1, "the admin's absence form should count toward the combined Parent card total, not the parent-only one");
});

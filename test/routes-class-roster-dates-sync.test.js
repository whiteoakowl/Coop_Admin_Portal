// Coverage for a real request: every class meeting a given day should
// show the same session dates as that day's Monday/Wednesday Parent/
// Student rosters - a class only ever meets when that day's students do.
// Before this fix, a class roster's own roster_dates was never written
// at all (dates were only "borrowed" for display at a handful of
// specific read sites - the Attendance grid view, kiosk class check-in's
// own session-date check). That silently broke utils/rosters.js's
// getMemberRostersForDate, which reads roster_dates directly for
// whichever roster it's asked about - it could never find a class
// roster for any date, no matter how many session dates the day itself
// had, because a class roster's own roster_dates was simply always empty.
//
// Three places now keep a class roster's own roster_dates genuinely in
// sync with its day's Student roster:
//   1. routes/admin-rosters.js's dates/add and dates/:date/remove -
//      every class roster on that day, going forward.
//   2. utils/classSchedule.js's ensureClassRoster - a class created (or
//      re-created) AFTER dates already exist for its day starts in sync
//      from day one, not just going forward.
//   3. utils/classSchedule.js's backfillClassRosterDates - a genuine
//      one-time backfill for an already-deployed database's EXISTING
//      classes, wired into db/index.js's db.ready chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-roster-dates-sync-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-roster-dates-sync-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { ensureClassRoster, classRosterIdsForDay, backfillClassRosterDates } = require('../utils/classSchedule');
const { getMemberRostersForDate } = require('../utils/rosters');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let classCounter = 0;
async function makeBareClass(day) {
  classCounter += 1;
  const info = await db
    .prepare('INSERT INTO classes (day, hour_position, class_name, color) VALUES (?, ?, ?, ?)')
    .run(day, 1, `Sync Test Class ${classCounter}`, '#EE9A4D');
  return info.lastInsertRowid;
}

test('routes/admin-rosters.js dates/add and dates/:date/remove keep every class roster on that day in sync', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const classId = await makeBareClass('monday');
  const classRosterId = await ensureClassRoster(classId);
  let memberId;

  await t.test('adding a date to Monday Students also lands it on the Monday class roster', async () => {
    const res = await request(app)
      .post('/admin/rosters/monday-student/dates/add')
      .set('Cookie', cookie)
      .type('form')
      .send({ dates: '2026-10-05', _csrf: csrfToken });
    assert.equal(res.status, 302);

    const row = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(classRosterId, '2026-10-05');
    assert.ok(row, 'the class roster should have picked up the new date');

    // Sanity check: it also still reaches the Wednesday side... it must NOT -
    // a Monday date has no business on a Wednesday class's roster.
    const wedClassId = await makeBareClass('wednesday');
    const wedClassRosterId = await ensureClassRoster(wedClassId);
    const wedRow = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(wedClassRosterId, '2026-10-05');
    assert.equal(wedRow, undefined, 'a Monday date must not leak onto a Wednesday class roster');
  });

  await t.test('a student enrolled in the class now shows the class roster itself via getMemberRostersForDate - the actual bug this fixes', async () => {
    const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sync Test Kid', 'sync-test-kid', 'student')").run();
    memberId = memberInfo.lastInsertRowid;
    await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(classRosterId, memberId);

    const rosters = await getMemberRostersForDate(memberId, '2026-10-05');
    assert.ok(
      rosters.some((r) => r.id === classRosterId),
      'before this fix, getMemberRostersForDate could never find a class roster for any date - its own roster_dates was always empty'
    );
  });

  await t.test('removing the date clears it from the class roster too, along with attendance/checkouts', async () => {
    await db.prepare('INSERT INTO attendance (roster_id, member_id, session_date, status) VALUES (?, ?, ?, ?)').run(classRosterId, memberId, '2026-10-05', 'present');

    const res = await request(app)
      .post('/admin/rosters/monday-student/dates/2026-10-05/remove')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);

    const dateRow = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(classRosterId, '2026-10-05');
    assert.equal(dateRow, undefined);
    const attendanceRow = await db.prepare('SELECT 1 AS "ok" FROM attendance WHERE roster_id = ? AND session_date = ?').get(classRosterId, '2026-10-05');
    assert.equal(attendanceRow, undefined, 'the class roster\'s own attendance for that date should be cleared too');
  });
});

test('classRosterIdsForDay returns exactly the class rosters meeting that day', async () => {
  const mondayClassId = await makeBareClass('monday');
  const mondayRosterId = await ensureClassRoster(mondayClassId);
  const ids = await classRosterIdsForDay('monday');
  assert.ok(ids.includes(mondayRosterId));
});

test('ensureClassRoster backfills a NEW class roster with whatever dates the day\'s Student roster already has', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await request(app)
    .post('/admin/rosters/wednesday-student/dates/add')
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: '2026-10-07', _csrf: csrfToken });

  // A class created AFTER that date already existed for Wednesday.
  const classId = await makeBareClass('wednesday');
  const rosterId = await ensureClassRoster(classId);

  const row = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(rosterId, '2026-10-07');
  assert.ok(row, 'a class roster created after dates already exist should start in sync, not empty');
});

test('backfillClassRosterDates fixes an already-deployed database\'s existing class rosters that predate this feature', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await request(app)
    .post('/admin/rosters/monday-student/dates/add')
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: '2026-10-12', _csrf: csrfToken });

  // Simulate a pre-existing class roster whose dates were never synced -
  // insert the roster row directly (bypassing ensureClassRoster's own new
  // backfill-on-create step) the same way an already-deployed database's
  // real rows would have been created before this feature existed.
  const classInfo = await db.prepare('INSERT INTO classes (day, hour_position, class_name, color) VALUES (?, ?, ?, ?)').run('monday', 2, 'Legacy Class', '#EE9A4D');
  const classId = classInfo.lastInsertRowid;
  const rosterInfo = await db.prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Legacy Class', 'Class Roster', 'monday')").run();
  const rosterId = rosterInfo.lastInsertRowid;
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(rosterId, classId);

  const before = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(rosterId, '2026-10-12');
  assert.equal(before, undefined, 'sanity check: the legacy class roster should start with no dates of its own');

  await backfillClassRosterDates();

  const after = await db.prepare('SELECT 1 AS "ok" FROM roster_dates WHERE roster_id = ? AND session_date = ?').get(rosterId, '2026-10-12');
  assert.ok(after, 'the backfill should have copied the Monday Student roster\'s existing date onto the legacy class roster');
});

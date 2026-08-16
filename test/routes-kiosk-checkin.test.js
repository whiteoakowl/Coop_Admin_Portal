// Real HTTP-level coverage for the kiosk check-in scan endpoint (audit
// finding TEST-01) - the single highest-traffic, highest-consequence
// write in the whole app: every family's actual presence record comes
// from this one route, unauthenticated, hit from a shared kiosk device
// hundreds of times a session day. Boots the real app (server.js) against
// a throwaway DB, same override pattern as test/designImageGC.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-kiosk-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-kiosk-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

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

// Puts a member on some active roster for today, via straight DB inserts
// - setup, not the thing under test, same as the rest of this session's
// live-verification did for the transaction-wrapped routes.
async function scheduleMemberToday(memberId) {
  const roster = await db.prepare('SELECT id FROM rosters WHERE active = 1 LIMIT 1').get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  return roster.id;
}

test('kiosk check-in scan', async (t) => {
  await t.test('an unrecognized barcode is rejected without creating any attendance row', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'NoSuchMember' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not recognized/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM attendance').get()).n), 0);
  });

  await t.test('a member not scheduled on any roster today is rejected', async () => {
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unscheduled Kid', 'Unscheduled Kid', 'student')").run();
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Unscheduled Kid' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not scheduled for a roster today/);
  });

  await t.test('a valid scan marks the member present and returns a welcome message', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Scan Test Kid', 'Scan Test Kid', 'student')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Scan Test Kid' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, 'Scan Test Kid');
    assert.match(res.body.message, /Welcome to Co-op, Scan Test Kid/);

    const attendance = await db
      .prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, rosterId, todayISO());
    assert.ok(attendance, 'expected an attendance row to have been written');
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.source, 'kiosk');
  });

  await t.test('scanning the same member again is idempotent and reports "already checked in"', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Scan Test Kid' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyChecked, true);
    assert.match(res.body.message, /already checked in/);

    // Still exactly one attendance row for this member - not a duplicate.
    const count = Number((await db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE source = ?').get('kiosk')).n);
    assert.equal(count, 1);
  });

  await t.test('an empty barcode is rejected without a database lookup crash', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: '   ' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /No barcode scanned/);
  });

  // A scan overriding a prior absent/late status - the behavior a late-
  // arriving family or a floater who was marked absent/late (e.g. via the
  // public absence form, or an admin editing the grid) depends on: showing
  // up and scanning in should always win, not leave them stuck showing as
  // absent/late for the rest of the day. Covers both a regular student
  // AND a floater (a parent on the day's Parent roster - floaters/
  // teachers/assistants are added there, so their presence is tracked
  // through this same roster/attendance mechanism, not a separate one).
  await t.test('checking in overrides an existing "absent" status to "present"', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Was Absent Kid', 'Was Absent Kid', 'student')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);
    await db.prepare(
      "INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'absence_form')"
    ).run(memberId, rosterId, todayISO());

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Was Absent Kid' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyChecked, undefined, 'a prior absent status should not be treated as "already checked in"');

    const attendance = await db
      .prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, rosterId, todayISO());
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.source, 'kiosk');
  });

  await t.test('checking in overrides an existing "late" status to "present" for a floater on the Parent roster', async () => {
    const parentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Was Late Floater', 'Was Late Floater', 'parent')")
      .run();
    await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(parentRoster.id, todayISO());
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(parentRoster.id, memberId);
    await db.prepare(
      "INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'late', 'absence_form')"
    ).run(memberId, parentRoster.id, todayISO());

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Was Late Floater' });
    assert.equal(res.body.ok, true);

    const attendance = await db
      .prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, parentRoster.id, todayISO());
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.source, 'kiosk');
  });
});

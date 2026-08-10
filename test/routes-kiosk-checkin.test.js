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

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

// Puts a member on some active roster for today, via straight DB inserts
// - setup, not the thing under test, same as the rest of this session's
// live-verification did for the transaction-wrapped routes.
function scheduleMemberToday(memberId) {
  const roster = db.prepare('SELECT id FROM rosters WHERE active = 1 LIMIT 1').get();
  const today = todayISO();
  db.prepare('INSERT OR IGNORE INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(roster.id, today);
  db.prepare("INSERT OR IGNORE INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(roster.id, memberId);
  return roster.id;
}

test('kiosk check-in scan', async (t) => {
  await t.test('an unrecognized barcode is rejected without creating any attendance row', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'NoSuchMember' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not recognized/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 0);
  });

  await t.test('a member not scheduled on any roster today is rejected', async () => {
    db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unscheduled Kid', 'Unscheduled Kid', 'student')").run();
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Unscheduled Kid' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not scheduled for a roster today/);
  });

  await t.test('a valid scan marks the member present and returns a welcome message', async () => {
    const { lastInsertRowid: memberId } = db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Scan Test Kid', 'Scan Test Kid', 'student')")
      .run();
    const rosterId = scheduleMemberToday(memberId);

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Scan Test Kid' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, 'Scan Test Kid');
    assert.match(res.body.message, /Welcome, Scan Test Kid/);

    const attendance = db
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
    const count = db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE source = ?').get('kiosk').n;
    assert.equal(count, 1);
  });

  await t.test('an empty barcode is rejected without a database lookup crash', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: '   ' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /No barcode scanned/);
  });
});

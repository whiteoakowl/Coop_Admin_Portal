// Real HTTP-level coverage for the roster Archive workflow (audit
// finding TEST-01) - archiveDay() is the one route in the app that both
// writes a permanent historical record AND deletes the live data it was
// built from, in the same request (now wrapped in db.withTransaction()
// - see routes/admin-rosters.js). A bug here doesn't just show a wrong
// number on screen, it can silently destroy a day's attendance records.
// Boots the real app (server.js) against a throwaway DB, same override
// pattern as test/designImageGC.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-archive-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-archive-test-uploads-${process.pid}`);
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

// Logs in and returns { cookie, csrfToken } - every /admin/* POST needs
// both (the session cookie to be recognized as an admin at all, and the
// token to get past middleware/csrfProtection.js).
async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/rosters?tab=monday-student').set('Cookie', cookie);
  const match = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  return { cookie, csrfToken: match ? match[1] : null };
}

test('roster archive', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  assert.ok(csrfToken, 'expected a CSRF token to be present on the rendered admin page');

  await t.test('a day with no session dates yet cannot be archived', async () => {
    const res = await request(app).post('/admin/rosters/wednesday/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM roster_archives WHERE day = 'wednesday'").get()).n), 0);
  });

  await t.test('archiving a day with data snapshots it and clears the live roster', async () => {
    const parentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
    const studentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Students'").get();
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Test Kid', 'Archive Test Kid', 'student')")
      .run();
    const today = todayISO();
    await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(studentRoster.id, today);
    await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(parentRoster.id, today);
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual')").run(studentRoster.id, memberId);
    await db.prepare(
      "INSERT INTO attendance (roster_id, member_id, session_date, status, source) VALUES (?, ?, ?, 'present', 'kiosk')"
    ).run(studentRoster.id, memberId, today);
    await db.prepare('INSERT INTO checkouts (member_id, roster_id, session_date, number, check_out_time) VALUES (?, ?, ?, ?, ?)').run(
      memberId,
      studentRoster.id,
      today,
      1,
      Date.now()
    );

    const res = await request(app).post('/admin/rosters/monday/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    // A permanent record was written...
    const archive = await db.prepare("SELECT * FROM roster_archives WHERE day = 'monday'").get();
    assert.ok(archive, 'expected an archive row to have been created');
    const snapshot = JSON.parse(archive.data_json);
    assert.equal(snapshot.day, 'monday');
    assert.ok(
      JSON.stringify(snapshot).includes('Archive Test Kid'),
      'expected the archived snapshot to contain the member who was checked in'
    );

    // ...and every live table the audit flagged is now clean for this
    // roster - across BOTH sibling rosters, same as the per-date removal
    // route's own transaction.
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM roster_dates WHERE roster_id IN (?, ?)').get(parentRoster.id, studentRoster.id)).n), 0);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE roster_id IN (?, ?)').get(parentRoster.id, studentRoster.id)).n), 0);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE roster_id IN (?, ?)').get(parentRoster.id, studentRoster.id)).n), 0);
    // Roster membership itself (who's on the roster, independent of any
    // date) is untouched - only the per-date data was in scope.
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM roster_members WHERE roster_id = ?').get(studentRoster.id)).n), 1);
  });

  await t.test('an unauthenticated request is rejected before reaching archiveDay at all', async () => {
    const res = await request(app).post('/admin/rosters/monday/archive').type('form').send({});
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/admin\/login/);
  });
});

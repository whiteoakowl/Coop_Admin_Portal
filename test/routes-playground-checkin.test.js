// Real HTTP-level coverage for a real request: "we need to add a
// playground check in and out and log. anybody can check in and out of
// the playground. it doesn't have a set roster." (routes/kiosk-class-
// checkin.js's playground routes, utils/playground.js). Mirrors test/
// routes-kiosk-class-checkin.test.js's own shape for the class flow, but
// the one thing genuinely under test here is different: unlike a class,
// there is no enrollment gate at all - any active member (student, parent,
// or admin, never seeded onto any roster_members row anywhere) must be
// able to check in and out, which is exactly what would silently break if
// a future edit accidentally copied resolveScan's own enrollment check
// into resolvePlaygroundScan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-playground-checkin-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-playground-checkin-test-uploads-${process.pid}`);
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

// A member with no roster/enrollment ties of any kind, plus today marked
// as a session date for that day's Student roster (what "is this day in
// session today" actually checks - see resolvePlaygroundScan) - setup, not
// the thing under test.
let setupCounter = 0;
async function setUpLooseMember({ day = 'monday', memberType = 'student' } = {}) {
  setupCounter += 1;
  const n = setupCounter;
  const today = todayISO();
  const studentRosterName = day === 'monday' ? 'Monday Students' : 'Wednesday Students';
  const studentRoster = await db.prepare('SELECT id FROM rosters WHERE name = ?').get(studentRosterName);
  await db
    .prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING')
    .run(studentRoster.id, today);

  const barcode = `Playground Loose Member ${n}`;
  const memberInfo = await db
    .prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)')
    .run(barcode, barcode, memberType);
  return { memberId: memberInfo.lastInsertRowid, barcode, day, today };
}

async function unlockedAgent() {
  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });
  return agent;
}

test('Playground Check-In day/hour navigation is reachable once unlocked', async (t) => {
  await t.test('locked out without the PIN, same gate as Class Check-In', async () => {
    const res = await request(app).get('/kiosk/class-checkin/playground');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/kiosk\/class-checkin\?next=/);
  });

  await t.test('day picker shows Monday and Wednesday once unlocked', async () => {
    const agent = await unlockedAgent();
    const res = await agent.get('/kiosk/class-checkin/playground');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/kiosk\/class-checkin\/playground\/monday"/);
    assert.match(res.text, /href="\/kiosk\/class-checkin\/playground\/wednesday"/);
  });

  await t.test('hour list shows all 4 hours for the chosen day', async () => {
    const agent = await unlockedAgent();
    const res = await agent.get('/kiosk/class-checkin/playground/monday');
    assert.equal(res.status, 200);
    for (let h = 1; h <= 4; h++) {
      assert.match(res.text, new RegExp(`href="/kiosk/class-checkin/playground/monday/${h}/attendance"`));
    }
  });

  await t.test('an invalid day 404s', async () => {
    const agent = await unlockedAgent();
    const res = await agent.get('/kiosk/class-checkin/playground/tuesday');
    assert.equal(res.status, 404);
  });
});

test('Playground Check-In: any active member can check in, with no roster or enrollment at all', async () => {
  const { memberId, barcode, today } = await setUpLooseMember({ day: 'monday' });
  const agent = await unlockedAgent();

  const res = await agent.post('/kiosk/class-checkin/playground/monday/1/scan/checkin').type('form').send({ barcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Welcome/);

  const rosterRow = await db.prepare('SELECT roster_id FROM playground_rosters WHERE day = ? AND hour_position = 1').get('monday');
  assert.ok(rosterRow, 'checking in should have lazily created the (monday, 1) playground roster');

  const attendanceRow = await db
    .prepare('SELECT status, source, check_in_time FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(memberId, rosterRow.roster_id, today);
  assert.equal(attendanceRow.status, 'present');
  assert.equal(attendanceRow.source, 'kiosk_playground');
  assert.ok(attendanceRow.check_in_time);
});

test('Playground Check-In: checking in twice reports already-checked instead of erroring', async () => {
  const { barcode } = await setUpLooseMember({ day: 'monday' });
  const agent = await unlockedAgent();
  await agent.post('/kiosk/class-checkin/playground/monday/2/scan/checkin').type('form').send({ barcode });
  const res = await agent.post('/kiosk/class-checkin/playground/monday/2/scan/checkin').type('form').send({ barcode });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyChecked, true);
  assert.match(res.body.message, /already checked in/);
});

test('Playground Check-In: check-out works with no prior check-in, and records the time', async () => {
  const { memberId, barcode, today } = await setUpLooseMember({ day: 'monday' });
  const agent = await unlockedAgent();

  const res = await agent.post('/kiosk/class-checkin/playground/monday/3/scan/checkout').type('form').send({ barcode });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /checked out/);

  const rosterRow = await db.prepare('SELECT roster_id FROM playground_rosters WHERE day = ? AND hour_position = 3').get('monday');
  const checkoutRow = await db
    .prepare('SELECT check_out_time, number FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(memberId, rosterRow.roster_id, today);
  assert.ok(checkoutRow.check_out_time);
  assert.equal(checkoutRow.number, null, 'playground checkouts never carry the numbered pickup value');
});

test('Playground Check-In: a day with no session date today is rejected', async () => {
  // wednesday hour 4 - never given a session date for today in this test's
  // own seeding, unlike monday above.
  const agent = await unlockedAgent();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Session Kid', 'No Session Kid', 'student')")
    .run();
  const res = await agent
    .post('/kiosk/class-checkin/playground/wednesday/4/scan/checkin')
    .type('form')
    .send({ barcode: 'No Session Kid' });
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /isn't in session today/);
  assert.ok(memberInfo.lastInsertRowid);
});

test('Playground Check-In: attendance log shows who has checked in and out today', async () => {
  const { barcode } = await setUpLooseMember({ day: 'monday' });
  const agent = await unlockedAgent();
  await agent.post('/kiosk/class-checkin/playground/monday/1/scan/checkin').type('form').send({ barcode });
  await agent.post('/kiosk/class-checkin/playground/monday/1/scan/checkout').type('form').send({ barcode });

  const res = await agent.get('/kiosk/class-checkin/playground/monday/1/attendance');
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(barcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(res.text, /href="\/kiosk\/class-checkin\/playground\/monday\/1\/scan\?mode=checkin"/);
  assert.match(res.text, /href="\/kiosk\/class-checkin\/playground\/monday\/1\/scan\?mode=checkout"/);
});

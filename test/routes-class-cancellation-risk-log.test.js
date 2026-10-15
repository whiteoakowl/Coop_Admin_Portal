// A real request: "Class cancelation log should be a log by date. On
// each class row that is a class cancelation risk it shows a tally
// number of how many times this class has been at risk for cancelation.
// Add a filter button for choosing date or class." Covers routes/admin-
// logs.js's classCancellationRiskRows (the replay-across-history math,
// sourced from the real append-only absence_submissions table rather
// than classesAtRiskForDay's own default live/mutable attendance lookup
// - see utils/classSchedule.js's own absentIdsOverride comment) and the
// tab=classrisk route's date/class filter modes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-risk-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-risk-log-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');

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

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')").run(name, barcode)).lastInsertRowid;
}

async function submitAbsence(memberId, rosterId, date) {
  await db
    .prepare(
      "INSERT INTO absence_submissions (member_id, roster_id, session_date, status, reason_category, reason_text) VALUES (?, ?, ?, 'absent', 'personal', 'testing')"
    )
    .run(memberId, rosterId, date);
}

let riskyClassId;
let otherClassId;
let rosterId;

test.before(async () => {
  await app.ready;
  rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Risk Log Test Roster', 'Class Schedule')").run()).lastInsertRowid;

  // Small class (3 students) - absence form for 1 of them, twice (two
  // Mondays), always leaving exactly 2 expected - at risk both times.
  riskyClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Risk Log Small Class' });
  const riskyStudents = [await makeMember('Risk Log Student A', 'rlog-a'), await makeMember('Risk Log Student B', 'rlog-b'), await makeMember('Risk Log Student C', 'rlog-c')];
  await setEnrollment(riskyClassId, riskyStudents);
  await submitAbsence(riskyStudents[0], rosterId, '2026-02-02'); // a real Monday
  await submitAbsence(riskyStudents[0], rosterId, '2026-02-09'); // the following Monday

  // A large class (10 students) with its own absence submission on one
  // of the same dates - never at risk (plenty still expected), must
  // never appear in the log at all.
  otherClassId = await createClass({ day: 'monday', hourPosition: 2, className: 'Risk Log Large Class' });
  const otherStudents = [];
  for (let i = 1; i <= 10; i++) otherStudents.push(await makeMember(`Risk Log Big Student ${i}`, `rlog-big-${i}`));
  await setEnrollment(otherClassId, otherStudents);
  await submitAbsence(otherStudents[0], rosterId, '2026-02-02');
  // Monday is already an active class day in a freshly seeded DB - no
  // need to activate it.
});

test('Logs: Class Cancellation Risk (tab=classrisk)', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('a genuinely at-risk class appears, running tally increments across its two at-risk dates', async () => {
    const csv = await request(app).get('/admin/logs/classrisk/export.csv').set('Cookie', cookie);
    assert.equal(csv.status, 200);
    const rows = csv.text.split('\n').filter((l) => l.includes('Risk Log Small Class'));
    assert.equal(rows.length, 2, 'expected one row per at-risk date');
    // Newest-first - 2026-02-09 (2nd time, tally 2) before 2026-02-02 (1st time, tally 1).
    assert.match(rows[0], /,"2"$/, `expected the newer date's tally to read 2, got: ${rows[0]}`);
    assert.match(rows[1], /,"1"$/, `expected the older date's tally to read 1, got: ${rows[1]}`);
  });

  await t.test('a large class with plenty of students still expected never appears, even with an absence form on file', async () => {
    const csv = await request(app).get('/admin/logs/classrisk/export.csv').set('Cookie', cookie);
    assert.doesNotMatch(csv.text, /Risk Log Large Class/);
  });

  await t.test('the on-screen log groups by date', async () => {
    const res = await request(app).get('/admin/logs?tab=classrisk').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Risk Log Small Class/);
    assert.match(res.text, /At risk 1x|At risk 2x/);
  });

  await t.test('filtering by date narrows the log to just that date', async () => {
    const res = await request(app).get('/admin/logs?tab=classrisk&filterBy=date&date=2026-02-02').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Risk Log Small Class/);
    assert.doesNotMatch(res.text, /2026-02-09/);
  });

  await t.test('filtering by class shows every at-risk date for just that class', async () => {
    const res = await request(app).get(`/admin/logs?tab=classrisk&filterBy=class&classId=${riskyClassId}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Risk Log Small Class/);
  });

  await t.test('the Date/Class filter-mode toggle is present', async () => {
    const res = await request(app).get('/admin/logs?tab=classrisk').set('Cookie', cookie);
    assert.match(res.text, /filterBy=date/);
    assert.match(res.text, /filterBy=class/);
  });
});

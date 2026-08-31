// Real HTTP-level coverage for a real bug report: "There should be a
// seperate log for Class Check in/out and co-op check in/out." Before
// this, admin-logs.js's single Check In/Out tab mixed both together -
// front-door Parent/Student check-ins (routes/kiosk.js) and per-class
// check-ins (routes/kiosk-class-checkin.js) both land on the attendance
// table, distinguished only by which roster the row belongs to (a
// class's own roster is category='Class Roster' - see
// utils/classSchedule.js's ensureClassRoster - vs the day-level
// Parent/Student rosters check-in uses, which never are).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-logs-class-vs-coop-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-logs-class-vs-coop-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

test('the Class and Co-op Check-In/Out logs stay separate', async (t) => {
  const { lastInsertRowid: coopRosterId } = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Monday Students Test', 'Class Schedule', 'monday')")
    .run();
  const { lastInsertRowid: classRosterId } = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Test Pottery Class', 'Class Roster', 'monday')")
    .run();

  const { lastInsertRowid: coopMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Coop Checkin Kid', 'Coop Checkin Kid', 'student')")
    .run();
  const { lastInsertRowid: classMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Class Checkin Kid', 'Class Checkin Kid', 'student')")
    .run();

  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2026-01-05', 'present', ?, 'kiosk')")
    .run(coopMemberId, coopRosterId, Date.now());
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2026-01-05', 'present', ?, 'kiosk')")
    .run(classMemberId, classRosterId, Date.now());

  const adminCookie = await loginAsAdmin();

  await t.test('the Co-op Check-In/Out tab shows the front-door check-in but not the class one', async () => {
    const res = await request(app).get('/admin/logs?tab=checkinout').set('Cookie', adminCookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Coop Checkin Kid/);
    assert.doesNotMatch(res.text, /Class Checkin Kid/);
  });

  await t.test('the Class Check-In/Out tab shows the class check-in but not the front-door one', async () => {
    const res = await request(app).get('/admin/logs?tab=classcheckinout').set('Cookie', adminCookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Class Checkin Kid/);
    assert.doesNotMatch(res.text, /Coop Checkin Kid/);
  });

  await t.test('each tab\'s CSV export stays scoped the same way', async () => {
    const coopCsv = await request(app).get('/admin/logs/checkinout/export.csv').set('Cookie', adminCookie);
    assert.match(coopCsv.text, /Coop Checkin Kid/);
    assert.doesNotMatch(coopCsv.text, /Class Checkin Kid/);

    const classCsv = await request(app).get('/admin/logs/classcheckinout/export.csv').set('Cookie', adminCookie);
    assert.match(classCsv.text, /Class Checkin Kid/);
    assert.doesNotMatch(classCsv.text, /Coop Checkin Kid/);
  });
});

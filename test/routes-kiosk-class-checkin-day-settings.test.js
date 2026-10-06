// A real bug report, found while generalizing Attendance/Rosters off the
// old 2-day utils/days.js: the Class Check-In kiosk's own day picker
// (GET /kiosk/class-checkin/classes) already listed every Day Settings-
// activated day ("Full 7 day expansion..." - a real request, utils/
// classSchedule.js's listActiveClassDays), but every OTHER route on this
// same router (the day's own class list, Playground's day/hour picker,
// its attendance/scan screens) still gated on utils/days.js's own
// isValidDay - Monday/Wednesday only. Clicking a newly-activated day
// (e.g. Tuesday) on the day picker 404'd immediately on the very next
// screen. Covers the public-facing kiosk flow end to end for a 3rd day,
// both Class Check-In and Playground.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `kiosk-class-checkin-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `kiosk-class-checkin-day-settings-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function activateTuesday() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: csrfToken });
}

async function setUpTuesdayClassWithStudent() {
  const today = todayISO();
  const studentRosterId = await ensureDayRoster('tuesday', 'student');
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(studentRosterId, today);

  const classInfo = await db
    .prepare('INSERT INTO classes (day, hour_position, class_name, color) VALUES (?, ?, ?, ?)')
    .run('tuesday', 1, 'Tuesday Art', '#EE9A4D');
  const classId = classInfo.lastInsertRowid;
  const classRosterInfo = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Tuesday Art', 'Class Roster', 'tuesday')")
    .run();
  const classRosterId = classRosterInfo.lastInsertRowid;
  await db.prepare('UPDATE classes SET roster_id = ? WHERE id = ?').run(classRosterId, classId);

  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Test Kid', 'Tuesday Test Kid', 'student')")
    .run();
  const memberId = memberInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(classRosterId, memberId);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto')").run(studentRosterId, memberId);

  return { classId, memberId };
}

test('Class Check-In: a newly-activated Tuesday day no longer 404s - full scan flow works', async (t) => {
  await activateTuesday();
  const { classId, memberId } = await setUpTuesdayClassWithStudent();

  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test('the day picker still lists Tuesday', async () => {
    const res = await agent.get('/kiosk/class-checkin/classes');
    assert.equal(res.status, 200);
    assert.match(res.text, /Tuesday/);
  });

  await t.test("Tuesday's own class list no longer 404s", async () => {
    const res = await agent.get('/kiosk/class-checkin/classes/tuesday');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`href="/kiosk/class-checkin/classes/${classId}/attendance"`));
  });

  await t.test("Tuesday's own class attendance sheet works", async () => {
    const res = await agent.get(`/kiosk/class-checkin/classes/${classId}/attendance`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Tuesday Art/);
  });

  await t.test('a real check-in scan against a Tuesday class succeeds', async () => {
    const member = await db.prepare('SELECT barcode FROM members WHERE id = ?').get(memberId);
    const res = await agent.post(`/kiosk/class-checkin/classes/${classId}/scan/checkin`).type('form').send({ barcode: member.barcode });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.alreadyChecked, undefined);
  });
});

test('Playground Check-In: a newly-activated Tuesday day no longer 404s', async (t) => {
  await activateTuesday();
  const today = todayISO();
  const studentRosterId = await ensureDayRoster('tuesday', 'student');
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(studentRosterId, today);

  const agent = request.agent(app);
  await agent.post('/kiosk/class-checkin/unlock').type('form').send({ pin: '0000' });

  await t.test("Tuesday's own Playground hour list no longer 404s", async () => {
    const res = await agent.get('/kiosk/class-checkin/playground/tuesday');
    assert.equal(res.status, 200);
    assert.match(res.text, /Tuesday/);
  });

  await t.test("Tuesday's own Playground attendance screen works", async () => {
    const res = await agent.get('/kiosk/class-checkin/playground/tuesday/1/attendance');
    assert.equal(res.status, 200);
    assert.match(res.text, /Tuesday/);
  });

  await t.test('a real Playground check-in scan on Tuesday succeeds', async () => {
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Playground Kid', 'Tuesday Playground Kid', 'student')").run();
    const res = await agent.post('/kiosk/class-checkin/playground/tuesday/1/scan/checkin').type('form').send({ barcode: 'Tuesday Playground Kid' });
    assert.equal(res.body.ok, true);
  });
});

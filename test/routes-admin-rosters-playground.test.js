// Real HTTP-level coverage for the Attendance page's new Playground tab -
// a real request: "add this as a tab under attendance called playground.
// each hour will be listed. when you click on them it opens to the log
// for that day, with a drop down to choose date of which log to look at.
// log shows check in time and check out time" (routes/admin-rosters.js's
// 'playground'/'playground-<day>-<hour>' tabs, utils/playground.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-playground-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-playground-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { ensurePlaygroundRoster } = require('../utils/playground');

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

test('the Playground tab appears in the Attendance tab bar and lists all 8 (day, hour) slots', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/rosters?tab=playground').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/admin\/rosters\?tab=playground">Playground<\/a>/);
  for (const day of ['monday', 'wednesday']) {
    for (let h = 1; h <= 4; h++) {
      assert.match(res.text, new RegExp(`href="/admin/rosters\\?tab=playground-${day}-${h}"`));
    }
  }
});

test('a specific playground hour shows a Session Date dropdown and today\'s log', async () => {
  const cookie = await loginAsAdmin();
  const today = todayISO();

  const studentRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Students'").get();
  await db
    .prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING')
    .run(studentRoster.id, today);

  const rosterId = await ensurePlaygroundRoster('monday', 1);
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Playground Admin Test Kid', 'Playground Admin Test Kid', 'student')")
    .run();
  await db
    .prepare(
      `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source)
       VALUES (?, ?, ?, 'present', ?, 'kiosk_playground')`
    )
    .run(memberInfo.lastInsertRowid, rosterId, today, Date.now());

  const res = await request(app).get('/admin/rosters?tab=playground-monday-1').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /id="playground-date-select"/);
  assert.match(res.text, /Playground Admin Test Kid/);
  assert.match(res.text, /Monday Playground/);
  // Nobody checked out yet - the row should show a blank dash, not a
  // fabricated time.
  assert.match(res.text, /<td class="roster-name-col">Playground Admin Test Kid<\/td>\s*<td>[^<]+<\/td>\s*<td>—<\/td>/);
});

test('an hour with no session dates yet shows an empty state instead of crashing', async () => {
  const cookie = await loginAsAdmin();
  // Wednesday hour 4 - never given a session date in this test file.
  const res = await request(app).get('/admin/rosters?tab=playground-wednesday-4').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No session dates yet/);
});

// A real bug report, found while generalizing the rest of the app off the
// old 2-day utils/days.js: Member Schedules (utils/schedule.js) had every
// one of its own functions (getMemberSchedule, scheduleList,
// arrivalDepartureLabels) hardcoded to exactly Monday + Wednesday.
// Covers the member profile Schedule tab, its fetch-on-open fragment,
// Print, and CSV export, for a 3rd day (Tuesday) - while Member
// Schedules' own Schedule CARD printing (the physical badge, utils/
// scheduleCardData.js) is deliberately left Monday/Wednesday-only, a
// separate badge-template redesign, not touched here. (The Member
// Schedule Archive feature this file used to also cover was later
// removed entirely, along with its own dedicated test file.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-schedules-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-schedules-day-settings-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=settings&settingsTab=days').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function activateTuesdayWithClass(admin) {
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: admin.csrfToken });

  await request(app)
    .post('/admin/class-schedule/tuesday/edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], _csrf: admin.csrfToken });

  const classInfo = await db
    .prepare("INSERT INTO classes (day, hour_position, class_name, color) VALUES ('tuesday', 1, 'Tuesday Robotics', '#EE9A4D')")
    .run();
  return classInfo.lastInsertRowid;
}

test('a Tuesday class enrollment shows up on the member profile Schedule tab, its fragment, Print, and CSV export', async () => {
  const admin = await loginAsAdmin();
  const classId = await activateTuesdayWithClass(admin);

  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Schedule Kid', 'Tuesday Schedule Kid', 'student')")
    .run();
  const studentId = studentInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);

  const profile = await request(app).get(`/admin/members/${studentId}?tab=schedule`).set('Cookie', admin.cookie);
  assert.equal(profile.status, 200);
  assert.match(profile.text, /Tuesday Schedule/);
  assert.match(profile.text, /Tuesday Robotics/);

  const fragment = await request(app).get(`/admin/members/${studentId}/schedule-fragment`).set('Cookie', admin.cookie);
  assert.equal(fragment.status, 200);
  assert.match(fragment.text, /Tuesday/);
  assert.match(fragment.text, /Tuesday Robotics/);

  const print = await request(app).get(`/admin/schedule/print?memberId=${studentId}`).set('Cookie', admin.cookie);
  assert.equal(print.status, 200);
  assert.match(print.text, /Tuesday/);
  assert.match(print.text, /Tuesday Robotics/);

  const csv = await request(app).get('/admin/schedule/export.csv').set('Cookie', admin.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /tuesday/);
  assert.match(csv.text, /Tuesday Robotics/);

  const manage = await request(app).get(`/admin/schedule/member/${studentId}/manage`).set('Cookie', admin.cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /Tuesday Schedule/);
  assert.match(manage.text, /Tuesday Robotics/);
});


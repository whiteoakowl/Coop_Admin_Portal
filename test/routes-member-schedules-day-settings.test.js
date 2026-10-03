// A real bug report, found while generalizing the rest of the app off the
// old 2-day utils/days.js: Member Schedules (utils/schedule.js) had every
// one of its own functions (getMemberSchedule, scheduleList,
// archiveMemberSchedules, arrivalDepartureLabels) hardcoded to exactly
// Monday + Wednesday - deeper than a missing day-list, since
// member_schedule_archives itself had fixed monday_schedule/
// wednesday_schedule columns. Covers the member profile Schedule tab, its
// fetch-on-open fragment, Print, CSV export, archiving, and the Archive
// tab's own display, all for a 3rd day (Tuesday) - while Member Schedules'
// own Schedule CARD printing (the physical badge, utils/scheduleCardData.js)
// is deliberately left Monday/Wednesday-only, a separate badge-template
// redesign, not touched here.
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

test('archiving a member with a Tuesday class snapshots it, and the Archive tab shows a Tuesday Schedule column', async () => {
  const admin = await loginAsAdmin();
  const classId = await activateTuesdayWithClass(admin);

  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Archive Kid', 'Tuesday Archive Kid', 'student')")
    .run();
  const studentId = studentInfo.lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);

  const archiveRes = await request(app)
    .post('/admin/schedule/members/archive')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberIds: String(studentId), _csrf: admin.csrfToken });
  assert.equal(archiveRes.status, 302);

  const archived = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Tuesday Archive Kid'").get();
  assert.ok(archived);
  const daySchedules = JSON.parse(archived.day_schedules_json);
  assert.match(daySchedules.tuesday || '', /Tuesday Robotics/);

  const archivePage = await request(app).get('/admin/schedule?tab=archive&type=student').set('Cookie', admin.cookie);
  assert.equal(archivePage.status, 200);
  assert.match(archivePage.text, /Tuesday Schedule/);
  assert.match(archivePage.text, /Tuesday Robotics/);

  const archiveCsv = await request(app).get('/admin/schedule/archive/student/export.csv').set('Cookie', admin.cookie);
  assert.equal(archiveCsv.status, 200);
  assert.match(archiveCsv.text, /Tuesday Schedule/);
  assert.match(archiveCsv.text, /Tuesday Robotics/);
});

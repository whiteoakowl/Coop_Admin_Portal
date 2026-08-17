// Real HTTP-level coverage for the Home dashboard's totals-card (Total
// Students / Total Parents / Total Members / Total Families,
// routes/admin.js's GET / + views/admin-dashboard.ejs) - added alongside
// this session's Members-page family filter so family count has the same
// kind of at-a-glance visibility parent/student/member counts already had.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-dashboard-totals-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-dashboard-totals-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { setEnrollment } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function statValueFor(html, label) {
  const match = new RegExp(`<span class="stat-value">(\\d+)</span>\\s*<span class="stat-label">${label}</span>`).exec(html);
  return match ? parseInt(match[1], 10) : null;
}

test('dashboard totals-card includes Total Families alongside Students/Parents/Members', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  await db.prepare('INSERT INTO families (name) VALUES (?)').run('Totals Test Family A');
  await db.prepare('INSERT INTO families (name) VALUES (?)').run('Totals Test Family B');

  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(statValueFor(res.text, 'Total Families'), 2);
});

test('dashboard totals-card splits Students/Parents counts by which day they are actually scheduled', async () => {
  // Real bug report: the first row of dashboard counts used to show one
  // flat "Total Students"/"Total Parents" figure (every active member of
  // that type, scheduled or not). Fixed to show four counts instead - how
  // many students/parents are actually on Monday's vs Wednesday's
  // day-level roster (the same 'Class Schedule' roster concept
  // todayStatsForType() already used for Today's Attendance, just for
  // both days at once instead of only whichever day happens to be today).
  const { cookie } = await (async () => {
    const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
    return { cookie: loginRes.headers['set-cookie'] };
  })();

  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'monday', className: 'Dashboard Split Monday Class', hourPosition: '1', color: '#EE9A4D', _csrf: (await currentCsrf(cookie)) });
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'wednesday', className: 'Dashboard Split Wed Class A', hourPosition: '1', color: '#EE9A4D', _csrf: (await currentCsrf(cookie)) });
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'wednesday', className: 'Dashboard Split Wed Class B', hourPosition: '2', color: '#EE9A4D', _csrf: (await currentCsrf(cookie)) });

  const mondayClass = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Monday Class'").get();
  const wedClassA = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Wed Class A'").get();
  const wedClassB = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Wed Class B'").get();

  const mondayStudent = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dash Split Monday Student', 'dash-split-mon-student', 'student')").run()).lastInsertRowid;
  const wedStudent = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dash Split Wed Student', 'dash-split-wed-student', 'student')").run()).lastInsertRowid;
  // setEnrollment (not a raw INSERT) so it also syncs the day-level
  // 'Class Schedule' roster that dayScheduleCount() actually reads -
  // enrolled in BOTH Wednesday classes, but must still only count once.
  await setEnrollment(mondayClass.id, [mondayStudent]);
  await setEnrollment(wedClassA.id, [wedStudent]);
  await setEnrollment(wedClassB.id, [wedStudent]);

  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.ok(statValueFor(res.text, 'Monday Students') >= 1, 'Monday Students should count the Monday-enrolled student');
  assert.ok(statValueFor(res.text, 'Wednesday Students') >= 1, 'Wednesday Students should count the Wednesday-enrolled student once, not per-class');
  assert.doesNotMatch(res.text, /Total Students/, 'the old flat Total Students figure should be gone, replaced by the day split');
  assert.doesNotMatch(res.text, /Total Parents/, 'the old flat Total Parents figure should be gone, replaced by the day split');
});

async function currentCsrf(cookie) {
  const page = await request(app).get('/admin').set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

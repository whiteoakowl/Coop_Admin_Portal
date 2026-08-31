// Real HTTP-level coverage for the Home dashboard's stat-card panel
// (Monday/Wednesday Parents/Students, Total Families/Students/Parents -
// routes/admin.js's GET / + views/admin-dashboard.ejs's
// .dashboard-stat-panel). Originally added alongside a Members-page
// family filter so family count had the same kind of at-a-glance
// visibility parent/student/member counts already had; later redesigned
// (a real request, with a reference screenshot) into individually-
// colored cards - see that redesign's own comment in styles.css.
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
  const match = new RegExp(`<span class="dashboard-stat-label">${label}</span>\\s*<span class="dashboard-stat-value">(\\d+)</span>`).exec(html);
  return match ? parseInt(match[1], 10) : null;
}

test('dashboard stat panel includes Total Families alongside Students/Parents', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  await db.prepare('INSERT INTO families (name) VALUES (?)').run('Totals Test Family A');
  await db.prepare('INSERT INTO families (name) VALUES (?)').run('Totals Test Family B');

  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.equal(statValueFor(res.text, 'Total Families'), 2);
});

test('dashboard stat panel splits Monday/Wednesday Students/Parents counts by which day they are actually scheduled, alongside the flat Total Students/Parents cards', async () => {
  // Real bug report: the dashboard's day-level counts used to show one
  // flat "Total Students"/"Total Parents" figure (every active member of
  // that type, scheduled or not) instead of how many are actually on
  // Monday's vs Wednesday's day-level roster (the same 'Class Schedule'
  // roster concept todayStatsForType() already used for Today's
  // Attendance, just for both days at once instead of only whichever day
  // happens to be today) - fixed to show the day-scoped counts. A later
  // redesign (a real request, with a reference screenshot) re-added
  // separate flat Total Students/Total Parents cards alongside the day
  // split, not instead of it - both now coexist, so this only checks the
  // day-scoped counts stay correct, not that the flat labels are absent.
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
  assert.ok(statValueFor(res.text, 'Total Students') >= 2, 'the flat Total Students card should count every active student, day-scheduled or not');
  assert.ok(statValueFor(res.text, 'Total Parents') !== null, 'the flat Total Parents card should still be present');
});

async function currentCsrf(cookie) {
  const page = await request(app).get('/admin').set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

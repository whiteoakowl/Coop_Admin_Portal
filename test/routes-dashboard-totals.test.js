// Real HTTP-level coverage for the Home dashboard's "Family & Student
// Counts" card (routes/admin.js's GET / + views/admin-dashboard.ejs's
// .family-student-counts-card) - a real request, with a reference
// screenshot, to replace the old 7-card Monday/Wednesday/Total stat grid
// with this single two-column (Monday | Wednesday) card: Parent Count,
// Student Count, and Total Families, each scoped to that one day instead
// of a flat site-wide total.
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

// Every "<label>"/value pair for a given row label appears twice in the
// card's own HTML - Monday's column first, Wednesday's second (see
// views/admin-dashboard.ejs) - so index 0/1 of this array are exactly
// that day split, in that order.
function statValuesFor(html, label) {
  const re = new RegExp(`<span class="family-student-row-label">${label}</span>\\s*<span class="family-student-row-value">(\\d+)</span>`, 'g');
  const values = [];
  let m;
  while ((m = re.exec(html))) values.push(parseInt(m[1], 10));
  return values;
}

async function currentCsrf(cookie) {
  const page = await request(app).get('/admin').set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

test('the Family & Student Counts card renders Monday and Wednesday columns with Parent Count, Student Count, and Total Families', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Family &amp; Student Counts/);
  assert.match(res.text, /Quick snapshot of key counts for upcoming days\./);
  assert.match(res.text, /<span class="family-student-day-pill">Monday<\/span>/);
  assert.match(res.text, /<span class="family-student-day-pill">Wednesday<\/span>/);
  assert.equal(statValuesFor(res.text, 'Parent Count').length, 2, 'Parent Count should appear once per day column');
  assert.equal(statValuesFor(res.text, 'Student Count').length, 2, 'Student Count should appear once per day column');
  assert.equal(statValuesFor(res.text, 'Total Families').length, 2, 'Total Families should appear once per day column, not a single flat total');
});

test('Total Families is scoped per day, not the old flat site-wide family count', async () => {
  const cookie = await loginAsAdmin();

  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'monday', className: 'Dashboard Family Monday Class', hourPosition: '1', color: '#EE9A4D', _csrf: await currentCsrf(cookie) });
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'wednesday', className: 'Dashboard Family Wed Class', hourPosition: '1', color: '#EE9A4D', _csrf: await currentCsrf(cookie) });

  const mondayClass = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Family Monday Class'").get();
  const wedClass = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Family Wed Class'").get();

  const { lastInsertRowid: familyId } = await db.prepare('INSERT INTO families (name) VALUES (?)').run('Dashboard Family Counts Test Family');
  const { lastInsertRowid: mondayOnlyStudent } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Dash Family Monday Student', 'dash-family-mon-student', 'student', ?)")
    .run(familyId);

  // setEnrollment (not a raw INSERT) so it also syncs the day-level
  // 'Class Schedule' roster that dayFamilyCount() actually reads - this
  // family only ever shows up under Monday, never Wednesday.
  await setEnrollment(mondayClass.id, [mondayOnlyStudent]);

  const before = await request(app).get('/admin').set('Cookie', cookie);
  const [mondayFamiliesBefore, wedFamiliesBefore] = statValuesFor(before.text, 'Total Families');

  const { lastInsertRowid: wedFamilyId } = await db.prepare('INSERT INTO families (name) VALUES (?)').run('Dashboard Family Counts Wed Family');
  const { lastInsertRowid: wedOnlyStudent } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Dash Family Wed Student', 'dash-family-wed-student', 'student', ?)")
    .run(wedFamilyId);
  await setEnrollment(wedClass.id, [wedOnlyStudent]);

  const after = await request(app).get('/admin').set('Cookie', cookie);
  const [mondayFamiliesAfter, wedFamiliesAfter] = statValuesFor(after.text, 'Total Families');

  assert.equal(mondayFamiliesAfter, mondayFamiliesBefore, "adding a Wednesday-only family shouldn't change Monday's own count");
  assert.equal(wedFamiliesAfter, wedFamiliesBefore + 1, "Wednesday's count should pick up the new Wednesday-only family");
});

test('dashboard stat panel splits Monday/Wednesday Students/Parents counts by which day they are actually scheduled', async () => {
  // Real bug report (carried over from the old 7-card layout, still true
  // of this card): day-level counts must reflect who's actually on that
  // day's 'Class Schedule' roster, not a flat site-wide total.
  const cookie = await loginAsAdmin();

  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'monday', className: 'Dashboard Split Monday Class', hourPosition: '2', color: '#EE9A4D', _csrf: await currentCsrf(cookie) });
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'wednesday', className: 'Dashboard Split Wed Class A', hourPosition: '2', color: '#EE9A4D', _csrf: await currentCsrf(cookie) });
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ day: 'wednesday', className: 'Dashboard Split Wed Class B', hourPosition: '3', color: '#EE9A4D', _csrf: await currentCsrf(cookie) });

  const mondayClass = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Monday Class'").get();
  const wedClassA = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Wed Class A'").get();
  const wedClassB = await db.prepare("SELECT id FROM classes WHERE class_name = 'Dashboard Split Wed Class B'").get();

  const mondayStudent = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dash Split Monday Student', 'dash-split-mon-student', 'student')").run()).lastInsertRowid;
  const wedStudent = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dash Split Wed Student', 'dash-split-wed-student', 'student')").run()).lastInsertRowid;
  // setEnrollment (not a raw INSERT) so it also syncs the day-level
  // 'Class Schedule' roster dayScheduleCount() actually reads - enrolled
  // in BOTH Wednesday classes, but must still only count once.
  await setEnrollment(mondayClass.id, [mondayStudent]);
  await setEnrollment(wedClassA.id, [wedStudent]);
  await setEnrollment(wedClassB.id, [wedStudent]);

  const res = await request(app).get('/admin').set('Cookie', cookie);
  const [mondayStudents, wedStudents] = statValuesFor(res.text, 'Student Count');
  assert.ok(mondayStudents >= 1, 'Monday should count the Monday-enrolled student');
  assert.ok(wedStudents >= 1, 'Wednesday should count the Wednesday-enrolled student once, not per-class');
});

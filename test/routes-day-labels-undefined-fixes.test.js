// More real gaps found auditing for leftover 2-day utils/days.js
// consumers: routes/admin-class-schedule.js (the Classes CRUD routes
// themselves) imported the plain DAY_LABELS re-exported from
// utils/classSchedule.js, which is actually the OLD Monday/Wednesday-only
// map from utils/days.js (confusingly re-exported under the exact same
// name as the real CLASS_DAY_LABELS_FULL) - so DAY_LABELS['tuesday'] was
// undefined, making the Manage Class page, the per-class roster print
// page, and the per-day Schedule print page all show the literal word
// "undefined" instead of "Tuesday" for any newly-activated 3rd+ day.
// utils/playground.js and utils/orientation.js had the exact same
// mistake, baking "undefined" into a Playground roster's own stored name
// and the Orientation tracker's Day column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `day-labels-undefined-fixes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `day-labels-undefined-fixes-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const classSchedule = require('../utils/classSchedule');
const { ensurePlaygroundRoster } = require('../utils/playground');

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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function activateTuesday(admin) {
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: admin.csrfToken });
}

test('Manage Class and roster print pages show "Tuesday", not "undefined", for a Tuesday class', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Label Class' });

  const manage = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  assert.equal(manage.status, 200);
  assert.doesNotMatch(manage.text, /undefined/);
  assert.match(manage.text, /Tuesday/);

  const rosterPrint = await request(app).get(`/admin/class-schedule/classes/${classId}/roster/print`).set('Cookie', admin.cookie);
  assert.equal(rosterPrint.status, 200);
  assert.doesNotMatch(rosterPrint.text, /undefined/);
});

test('the per-day Schedule print page title/label say "Tuesday", not "undefined"', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  const print = await request(app).get('/admin/class-schedule/tuesday/print').set('Cookie', admin.cookie);
  assert.equal(print.status, 200);
  assert.doesNotMatch(print.text, /undefined/);
  assert.match(print.text, /Tuesday Schedule/);
});

test('a Tuesday Playground roster is named "Playground - Tuesday ...", not "Playground - undefined ..."', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  const rosterId = await ensurePlaygroundRoster('tuesday', 1);
  const roster = await db.prepare('SELECT name FROM rosters WHERE id = ?').get(rosterId);
  assert.match(roster.name, /^Playground - Tuesday /);
  assert.doesNotMatch(roster.name, /undefined/);
});

test('the Orientation tracker shows "Tuesday" in the Day column for a family enrolled in a Tuesday class', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Orientation Class' });

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Orientation Tuesday Family')).lastInsertRowid;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1)")
      .run('Orientation Tuesday Parent', 'orientation-tuesday-parent', familyId)
  ).lastInsertRowid;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'student', ?, 1)")
      .run('Orientation Tuesday Student', 'orientation-tuesday-student', familyId)
  ).lastInsertRowid;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentId);

  const page = await request(app).get('/admin/orientation').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Orientation Tuesday Parent/);
  assert.doesNotMatch(page.text, /undefined/);
  const rowStart = page.text.indexOf('Orientation Tuesday Parent');
  const rowEnd = page.text.indexOf('</tr>', rowStart);
  assert.match(page.text.slice(rowStart, rowEnd), />Tuesday</);
});

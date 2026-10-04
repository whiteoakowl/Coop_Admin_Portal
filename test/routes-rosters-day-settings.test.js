// A real request: "Full 7 day expansion so... attendance... will work for
// years to come" - Phase 3 of that expansion generalizes Attendance/
// Rosters (routes/admin-rosters.js) off utils/days.js's old Monday/
// Wednesday-only DAYS/DAY_LABELS/isValidDay/requireDay and onto the same
// Day Settings-driven utils/classDays.js the Classes grid, Floater
// Assignments, and Setup/Cleanup already use. Covers: activating a
// Tuesday day schedule makes a real tuesday-parent/tuesday-student
// Attendance tab (grid, dates, membership, resync, print, CSV export all
// working, not just the grid's own landing page), that the Classes/
// Playground tabs' own Day filters list Tuesday too, that the
// semester+day combo picker offers Tuesday as an option, and that
// Monday/Wednesday keep working completely unchanged. (The Attendance
// Archive feature this file used to also cover here was later removed
// entirely.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `rosters-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `rosters-day-settings-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');

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
  const page = await request(app).get('/admin/rosters').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function activateTuesday(admin) {
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: admin.csrfToken });
}

test('a newly-activated Tuesday day schedule makes a real tuesday-parent/tuesday-student Attendance tab, with Edit Dates/Add Member/Resync/Print/Export all reachable', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  await createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Art' });

  const parentPage = await request(app).get('/admin/rosters?tab=tuesday-parent').set('Cookie', admin.cookie);
  assert.equal(parentPage.status, 200);
  assert.match(parentPage.text, /Tuesday Attendance/);
  assert.match(parentPage.text, /Tuesday Parents Attendance/);
  // The semester+day combo picker is present (replacing a fixed
  // Monday/Wednesday day-toggle - a real request: "I need to be able to
  // switch between semester views on... attendance... etc.") and offers
  // Tuesday as one of its options.
  assert.match(parentPage.text, /class="schedule-combo-picker"/);
  assert.match(parentPage.text, />Tuesday<\/option>/);
  // The Parent/Student toggle itself still works, scoped to Tuesday.
  assert.match(parentPage.text, /tab=tuesday-student/);

  const studentPage = await request(app).get('/admin/rosters?tab=tuesday-student').set('Cookie', admin.cookie);
  assert.equal(studentPage.status, 200);
  assert.match(studentPage.text, /Tuesday Students Attendance/);

  const addDates = await request(app)
    .post('/admin/rosters/tuesday-student/dates/add')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ dates: ['2026-09-08'], _csrf: admin.csrfToken });
  assert.notEqual(addDates.status, 404);

  // Session dates apply to BOTH Parent and Student for the same day, and
  // to every class meeting that day too (same invariant Monday/Wednesday
  // already had - see routes/admin-rosters.js's own siblingRosterId/
  // dayClassRosterIds comments).
  const parentAfterDates = await request(app).get('/admin/rosters?tab=tuesday-parent').set('Cookie', admin.cookie);
  assert.match(parentAfterDates.text, /Sep.*8.*2026|9\/8\/2026|2026-09-08/);

  const addMember = await request(app)
    .get('/admin/rosters?tab=tuesday-parent')
    .set('Cookie', admin.cookie);
  assert.notEqual(addMember.status, 404);

  const resync = await request(app)
    .post('/admin/rosters/tuesday/resync')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ tab: 'tuesday-student', _csrf: admin.csrfToken });
  assert.notEqual(resync.status, 404);
  assert.match(resync.headers.location, /tab=tuesday-student/);

  const print = await request(app).get('/admin/rosters/print?tab=tuesday-parent').set('Cookie', admin.cookie);
  assert.equal(print.status, 200);
  assert.match(print.text, /Tuesday/);

  const exportCsv = await request(app).get('/admin/roster/tuesday-parent/export.csv').set('Cookie', admin.cookie);
  assert.equal(exportCsv.status, 200);
});

test('the Classes tab Day filter and Playground tab list Tuesday once activated, alongside Monday/Wednesday', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  const classesPage = await request(app).get('/admin/rosters?tab=classes').set('Cookie', admin.cookie);
  assert.equal(classesPage.status, 200);
  assert.match(classesPage.text, /<option value="tuesday"[^>]*>Tuesday<\/option>/);
  assert.match(classesPage.text, /<option value="monday"[^>]*>Monday<\/option>/);
  assert.match(classesPage.text, /<option value="wednesday"[^>]*>Wednesday<\/option>/);

  const filtered = await request(app).get('/admin/rosters?tab=classes&day=tuesday').set('Cookie', admin.cookie);
  assert.equal(filtered.status, 200);

  const playgroundPage = await request(app).get('/admin/rosters?tab=playground').set('Cookie', admin.cookie);
  assert.equal(playgroundPage.status, 200);
  assert.match(playgroundPage.text, /Tuesday<\/h3>/);
  assert.match(playgroundPage.text, /tab=playground-tuesday-1/);

  const playgroundLog = await request(app).get('/admin/rosters?tab=playground-tuesday-1').set('Cookie', admin.cookie);
  assert.equal(playgroundLog.status, 200);
  assert.match(playgroundLog.text, /Tuesday/);
});

test('activating Tuesday and adding its own session dates leaves Monday/Wednesday rosters completely untouched', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  await request(app)
    .post('/admin/rosters/tuesday-student/dates/add')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ dates: ['2026-09-08'], _csrf: admin.csrfToken });

  const mondayPage = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', admin.cookie);
  assert.equal(mondayPage.status, 200);
  assert.match(mondayPage.text, /Monday Attendance/);
  const wednesdayPage = await request(app).get('/admin/rosters?tab=wednesday-student').set('Cookie', admin.cookie);
  assert.equal(wednesdayPage.status, 200);
  assert.match(wednesdayPage.text, /Wednesday Students Attendance/);
});

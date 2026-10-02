// A real bug report: "there are currently many people signed up for fall
// 2026 classes. They aren't showing on this orientation list." Root cause:
// createClass never set semester_id at all, so every class left it NULL
// until an admin remembered to open that one class's own Details tab and
// pick a semester by hand - and utils/orientation.js's own orientationRows
// matches semester_id exactly, so a NULL-semester class's enrolled
// students never showed under a specific semester's filtered view. Covers
// both halves of the fix: new classes now default to the current
// semester automatically, and classes that already slipped through before
// that fix existed can be bulk-assigned from Settings in one click.
// Its own file (not routes-class-schedule-semesters.test.js) so the very
// first class ever created in this DB genuinely has no semester to
// default to yet - every top-level test() in one file shares the same
// PGlite instance, and the sibling file's own tests already create
// semesters before this scenario could run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-missing-semester-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-missing-semester-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, getClass } = require('../utils/classSchedule');

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

test('a brand new class defaults to the most-recently-created semester, and classes already missing one can be bulk-assigned from Settings', async () => {
  const admin = await loginAsAdmin();

  // No semesters yet - a class created now has nothing to default to.
  const earlyClassId = await createClass({ day: 'monday', hourPosition: 1, className: 'Created Before Any Semester' });
  assert.equal((await getClass(earlyClassId)).semester_id, null);

  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall 2026', _csrf: admin.csrfToken });
  const fall2026 = await db.prepare('SELECT * FROM semesters WHERE title = ?').get('Fall 2026');

  // Created AFTER a semester exists - should default to it automatically.
  const laterClassId = await createClass({ day: 'wednesday', hourPosition: 2, className: 'Created After Fall 2026 Existed' });
  assert.equal((await getClass(laterClassId)).semester_id, fall2026.id);

  // The Settings tab should surface the still-unassigned class and offer
  // a one-click fix.
  const settings = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.match(settings.text, /Classes With No Semester/);
  assert.match(settings.text, /1 class has no semester assigned/);

  await request(app)
    .post('/admin/schedule/semesters/assign-missing')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ semesterId: String(fall2026.id), _csrf: admin.csrfToken });

  assert.equal((await getClass(earlyClassId)).semester_id, fall2026.id, 'the previously-unassigned class should now be tagged Fall 2026');

  const settingsAfter = await request(app).get('/admin/schedule?tab=settings').set('Cookie', admin.cookie);
  assert.doesNotMatch(settingsAfter.text, /Classes With No Semester/, 'the bulk-assign section should disappear once nothing is missing a semester');
});

test('the Monday/Wednesday Classes page also has an Add/Edit Semester button that opens the same semester manager', async () => {
  const admin = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Add\/Edit Semester/);
  assert.match(page.text, /id="semester-manager-dialog-monday"/);
});

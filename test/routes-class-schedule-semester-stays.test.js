// A real bug report: "When duplicating classes, editing a class, etc it
// should stay on that semester. It keeps falling back to fall semesters."
// routes/admin-schedule.js's own resolveSemesterId falls back to Settings
// > Kiosk's active semester (Fall, for this co-op) whenever a request
// lands on /admin/schedule with no explicit ?semesterId= - every
// edit/duplicate/delete/bulk-edit/import/create redirect in routes/
// admin-class-schedule.js used to omit it entirely, so saving anything on
// a non-active semester's grid bounced the admin back to Fall instead of
// the semester they were actually working in. Covers each of those
// redirects landing on the semester the class actually belongs to (or,
// for day-level actions with no single class, the semester the grid was
// opened from) instead of the active kiosk semester.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-semester-stays-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-semester-stays-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, createSemester, createClassSchedule } = require('../utils/classSchedule');
const { setActiveKioskSemesterId } = require('../utils/kioskSettings');

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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

// Fall is the active kiosk semester throughout - every assertion below
// checks the redirect lands on Spring (or none), never silently falling
// back to this one.
async function setupFallAndSpring() {
  const fall = await createSemester(`Fall Stays Test ${Date.now()}`);
  const spring = await createSemester(`Spring Stays Test ${Date.now()}`);
  await setActiveKioskSemesterId(fall.id);
  return { fall, spring };
}

test('editing a class on a non-active semester redirects back to that semester, not the active (Fall) one', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Spring Pottery', semesterId: spring.id });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Spring Pottery', hourPosition: '1', semesterId: String(spring.id), _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${spring.id}\\b`));
});

test('moving a class to a different semester via its own Edit form redirects to the NEW semester, not the old one', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();
  // Starts untagged (no semester) - the edit below moves it to Spring.
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Moving Class' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Moving Class', hourPosition: '2', semesterId: String(spring.id), _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${spring.id}\\b`));
});

test('deleting a class on a non-active semester redirects back to that semester', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Delete Me', semesterId: spring.id });

  const res = await request(app).post(`/admin/class-schedule/classes/${classId}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${spring.id}\\b`));
});

test('duplicating a class onto a Spring combo: the new class\'s own "Back to Day Schedule" link stays on Spring, not Fall', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();
  const springMondayComboId = await createClassSchedule({ title: 'Spring - Monday', dayOfWeek: 'monday', semesterId: spring.id });
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Original Class' });

  const dupRes = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/duplicate`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ targetComboId: String(springMondayComboId), _csrf: admin.csrfToken });
  assert.equal(dupRes.status, 302);
  const manageMatch = /\/admin\/class-schedule\/classes\/(\d+)\/manage/.exec(dupRes.headers.location);
  assert.ok(manageMatch, 'expected a redirect to the new class\'s own manage page');

  const managePage = await request(app).get(dupRes.headers.location).set('Cookie', admin.cookie);
  assert.equal(managePage.status, 200);
  assert.match(managePage.text, new RegExp(`href="/admin/schedule\\?tab=monday&semesterId=${spring.id}"`));
});

test('creating a class from a non-active semester\'s grid redirects back to that semester', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();

  const res = await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'monday', className: 'New Spring Class', hourPosition: '3', gridSemesterId: String(spring.id), _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${spring.id}\\b`));
});

test('bulk-editing classes from a non-active semester\'s grid redirects back to that semester', async () => {
  const admin = await loginAsAdmin();
  const { spring } = await setupFallAndSpring();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Bulk Target', semesterId: spring.id });

  const res = await request(app)
    .post('/admin/class-schedule/monday/bulk-edit')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ classIds: String(classId), room: 'Room Z', gridSemesterId: String(spring.id), _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, new RegExp(`semesterId=${spring.id}\\b`));
});

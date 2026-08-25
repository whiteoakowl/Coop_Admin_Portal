// Real HTTP-level coverage for a real bug report: "when adding or
// deleting new members on edit class popup it goes to an error page."
// Every enrollment/staff/roster mutation route in routes/admin-class-
// schedule.js called straight into setEnrollment/addStaff/removeStaff
// with no try/catch, so any failure there fell through to server.js's
// generic catch-all and rendered a blank "Something went wrong" page
// with no way to tell what happened - the exact same class of bug
// already fixed once for routes/admin-documents.js's upload route (see
// that file's own comment). A non-existent member id is a real, easy way
// to force setEnrollment/addStaff to genuinely fail (a real foreign key
// violation, not a simulated error), which is exactly what these tests
// use to prove the fix actually surfaces the real reason instead of
// crashing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-roster-errors-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-roster-errors-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const { createClass } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

const NONEXISTENT_MEMBER_ID = 999999;

test('enrollment/add with a non-existent student id redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Roster Error Class A' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ studentIds: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  // supertest doesn't follow redirects - this is the first hop
  // (/admin/class-schedule/:day, itself a redirect to /admin/schedule?tab=...
  // that carries every query param through, see routes-class-schedule-
  // tabs.test.js) - what matters here is that it's a real redirect
  // carrying the error, not a 500 crash page.
  assert.match(res.headers.location, /\/admin\/class-schedule\/monday\?/);
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not update roster/);
});

test('staff/add with a non-existent member id redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Roster Error Class B' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/staff/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(NONEXISTENT_MEMBER_ID), role: 'teacher', _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  assert.match(res.headers.location, /\/admin\/class-schedule\/monday\?/);
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not update roster/);
});

test('roster/add (the popup\'s combined Add Member form) with a non-existent student id: plain form falls back to a friendly redirect, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Roster Error Class C' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/roster/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ role: 'student', studentId: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not add member/);
});

test('roster/add via fetch (Accept: application/json, the popup\'s real request shape) with a non-existent student id: a graceful JSON error, not a 500 HTML crash page', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 4, className: 'Roster Error Class D' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/roster/add`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ role: 'student', studentId: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 500, 'this is the one genuinely failed request - a real error status, not a redirect');
  assert.equal(res.headers['content-type'].includes('application/json'), true, 'must stay JSON so the popup\'s own fetch().then(res.json()) can read it, not an HTML crash page');
  assert.equal(res.body.ok, false);
  assert.ok(res.body.error, 'the real underlying error message should be present, not swallowed');
});

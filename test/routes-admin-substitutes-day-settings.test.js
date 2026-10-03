// A real gap found while auditing the rest of the app for leftover 2-day
// utils/days.js consumers after the Kiosk/Dashboard/Name-Tags/Member-
// Schedules generalization pass: the Substitutes board (routes/admin-
// substitutes.js, folded into the Floater Assignments manage page) was
// still gated by the old requireDay middleware, so every one of its
// routes - including the Add Position dialog's own save - 404'd for any
// day beyond Monday/Wednesday. permanent_jobs also still had the
// original 2-day CHECK constraint, so even past the 404 the insert
// itself would have failed for a 3rd+ day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-substitutes-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-substitutes-day-settings-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('a permanent job can be created on the Substitutes board for Tuesday, not just Monday/Wednesday', async () => {
  const cookie = await loginAsAdmin();

  const page = await request(app).get('/admin/volunteers/tuesday/manage').set('Cookie', cookie);
  assert.equal(page.status, 200, 'GET /admin/volunteers/tuesday/manage must not 404');
  const csrfToken = extractCsrf(page.text);

  const createRes = await request(app)
    .post('/admin/volunteers/tuesday/substitutes/permanent-jobs/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ title: 'Tuesday Front Desk', hourPositions: ['1', '2'], _csrf: csrfToken });
  assert.equal(createRes.status, 302, 'the create POST must not 404');
  assert.match(createRes.headers.location, /\/admin\/volunteers\/tuesday\/manage/);

  const rows = await db.prepare("SELECT * FROM permanent_jobs WHERE day = 'tuesday' AND title = 'Tuesday Front Desk'").all();
  assert.equal(rows.length, 2, 'one row per selected hour, and the insert must not violate the day CHECK constraint');

  const manage = await request(app).get('/admin/volunteers/tuesday/manage').set('Cookie', cookie);
  assert.match(manage.text, /Tuesday Front Desk/);
});

test('the old standalone /volunteers/:day/substitutes route still redirects for Tuesday instead of 404ing', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/tuesday/substitutes').set('Cookie', cookie);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/volunteers\/tuesday\/manage/);
});

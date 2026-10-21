// A real request: "all pages/subpages across the entire app where there
// are print, export, import, or download buttons should be changed to
// icons, and those pages/subpages should have all four." Floater
// Assignments' own Class Cancellation Risk tab (views/admin-volunteer-
// risk.ejs) only had Print - this covers its new Export (icon button +
// routes/admin-volunteers.js's own GET /volunteers/:day/risk/export.csv).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-risk-export-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-risk-export-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

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

test('Floater Assignments Class Cancellation Risk tab: Export and Print are icon buttons, Export downloads a CSV', async () => {
  const cookie = await loginAsAdmin();

  const page = await request(app).get('/admin/volunteers/monday/risk').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<a class="icon-btn" href="\/admin\/volunteers\/monday\/risk\/export\.csv[^"]*" aria-label="Export CSV"/);
  assert.match(page.text, /<button type="button" class="icon-btn" onclick="window\.print\(\)" aria-label="Print"/);

  const csv = await request(app).get('/admin/volunteers/monday/risk/export.csv').set('Cookie', cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /Hour.*Class.*Room.*Expected.*Enrolled/);
});

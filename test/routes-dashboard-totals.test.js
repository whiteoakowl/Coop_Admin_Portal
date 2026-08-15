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

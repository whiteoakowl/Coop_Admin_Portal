// Main Admin Portal's own copy of routes/admin-name-tag.js's barcode-only
// print sheet (routes/main-admin-name-tags.js, same per-portal
// duplication convention this app uses throughout). A real request:
// "printing barcodes only, should have the member ID number on there as
// well" - see test/routes-name-tag-barcode-print.test.js for the Co-op
// Admin Portal's own coverage of the same fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-name-tag-barcode-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-name-tag-barcode-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('Main Admin barcode-only print sheet shows each member\'s own ID number', async () => {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Riley ID Member', '000222', '000222', 'student')")
    .run();

  const res = await request(app)
    .post('/main-admin/name-tags/print-barcodes')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: memberId, _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.match(res.text, /<div class="barcode-cell-name">Riley ID Member<\/div>/);
  assert.match(res.text, /<div class="barcode-cell-id">ID: 000222<\/div>/);
});

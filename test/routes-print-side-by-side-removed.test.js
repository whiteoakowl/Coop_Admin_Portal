// A real request: "Printing, name tags + schedule cards (front and back)
// description the page should say. Printer settings: Step 1 - flip on
// long edge. Step 2: print double sided. Remove printing name tags side
// by side." Covers both the bulk Design/Print hub (Co-op Admin and Main
// Admin) and the per-member Cards dialog (Co-op Admin only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `print-side-by-side-removed-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `print-side-by-side-removed-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const res = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return res.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const res = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123' });
  return res.headers['set-cookie'];
}

test('Co-op Admin Design/Print hub: no side-by-side option, duplex panel has Step 1/Step 2 printer settings', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Name Tags \+ Schedule Cards</, 'the plain "Name Tags + Schedule Cards" (side by side) option should be gone');
  assert.doesNotMatch(res.text, /id="print-cardsBoth-section"/);
  assert.doesNotMatch(res.text, /side by side/i);
  assert.match(res.text, /Step 1 - flip on long edge/);
  assert.match(res.text, /Step 2 - print double sided/);
});

test('Main Admin Design/Print hub: no side-by-side option, duplex panel has Step 1/Step 2 printer settings', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Name Tags \+ Schedule Cards</);
  assert.doesNotMatch(res.text, /id="print-cardsBoth-section"/);
  assert.doesNotMatch(res.text, /side by side/i);
  assert.match(res.text, /Step 1 - flip on long edge/);
  assert.match(res.text, /Step 2 - print double sided/);
});

test('the removed bulk /print-both routes 404 on both portals', async () => {
  const coopCookie = await loginAsAdmin();
  const coopPage = await request(app).get('/admin/design?tab=print').set('Cookie', coopCookie);
  const coopCsrf = /name="csrf-token" content="([^"]*)"/.exec(coopPage.text)[1];
  const coopRes = await request(app)
    .post('/admin/design/print-both')
    .set('Cookie', coopCookie)
    .type('form')
    .send({ _csrf: coopCsrf });
  assert.equal(coopRes.status, 404);

  const mainCookie = await loginAsMainAdmin();
  const mainPage = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', mainCookie);
  const mainCsrf = /name="csrf-token" content="([^"]*)"/.exec(mainPage.text)[1];
  const mainRes = await request(app)
    .post('/main-admin/name-tags/print-both')
    .set('Cookie', mainCookie)
    .type('form')
    .send({ _csrf: mainCsrf });
  assert.equal(mainRes.status, 404);
});

test('per-member Cards dialog dropdown no longer offers Side by Side', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Side By Side Kid', 'Side_By_Side_Kid', 'student')")
    .run();
  const res = await request(app).get(`/admin/members/${memberId}/cards-fragment`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Side by Side/);
  assert.doesNotMatch(res.text, /value="sideBySide"/);

  // The layout itself, if requested directly by URL, now falls back to
  // nameTag rather than erroring or rendering the removed pairs view.
  const printRes = await request(app).get(`/admin/members/${memberId}/cards/print?layout=sideBySide`).set('Cookie', cookie);
  assert.equal(printRes.status, 200);
  assert.match(printRes.text, /Name Tag<\/h2>/);
});

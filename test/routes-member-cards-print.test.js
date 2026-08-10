// Real HTTP-level coverage for the per-member Cards dialog's print
// dropdown (task #88, routes/admin-members.js's /members/:id/cards/print).
// The four layouts render three genuinely different views (a single-card
// page, the side-by-side pairs page, and the front-and-back duplex page
// shared with the bulk Design/Print flow - see utils/cardPairs.js and
// utils/duplexPrint.js), so a route-level test that only checked "200 OK"
// would miss a layout silently falling back to the wrong view. Boots the
// real app (server.js) against a throwaway DB, same pattern as the other
// test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-member-cards-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-member-cards-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

test('member Cards dialog print layouts', async (t) => {
  const cookie = await loginAsAdmin();
  const memberInfo = db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Layout Kid', 'Print_Layout_Kid', 'student')")
    .run();
  const memberId = memberInfo.lastInsertRowid;

  await t.test('nameTag renders a single-card page with just the Name Tag', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print?layout=nameTag`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Name Tag<\/h2>/);
    assert.doesNotMatch(res.text, /Schedule Card<\/h2>/);
  });

  await t.test('scheduleCard renders a single-card page with just the Schedule Card', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print?layout=scheduleCard`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Schedule Card<\/h2>/);
    assert.doesNotMatch(res.text, /Name Tag<\/h2>/);
  });

  await t.test('sideBySide renders the pairs view with one row for the member', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print?layout=sideBySide`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /member-card-pair-row/);
    const rowCount = (res.text.match(/member-card-pair-row/g) || []).length;
    assert.equal(rowCount, 1, 'exactly one pair row for one member');
  });

  await t.test('frontBack renders the duplex view: name tag on the front page, schedule card mirrored onto the back page', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print?layout=frontBack`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    const pageCount = (res.text.match(/badge-sheet-page badge-sheet/g) || []).length;
    assert.equal(pageCount, 2, 'one front page and one back page');
    // A lone card in a row mirrors to the second grid slot with the first
    // slot left blank - see utils/duplexPrint.js's mirrorPage - so the
    // back page must contain exactly one blank filler.
    assert.match(res.text, /badge-canvas-blank/);
  });

  await t.test('an unrecognized layout falls back to nameTag rather than erroring', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print?layout=not-a-real-layout`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Name Tag<\/h2>/);
  });

  await t.test('omitting layout entirely also falls back to nameTag', async () => {
    const res = await request(app).get(`/admin/members/${memberId}/cards/print`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Name Tag<\/h2>/);
  });

  await t.test('a nonexistent member id 404s', async () => {
    const res = await request(app).get('/admin/members/999999/cards/print?layout=nameTag').set('Cookie', cookie);
    assert.equal(res.status, 404);
  });
});

// Real request: "when clicking the icon on member list to send to name
// tags request log the page should not refresh everytime." Covers Main
// Admin's own mirror of Co-op Admin's request-name-tag route/button -
// see test/routes-admin-members-name-tag-request.test.js for the Co-op
// Admin coverage (which also covers the "already on the log" info state).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-name-tag-request-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-name-tag-request-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function login() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Main Admin Members list Add-to-Name-Tag-Request-Log icon', async (t) => {
  const cookie = await login();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Admin Name Tag Request Member', 'main-admin-name-tag-request-member', 'parent')").run())
    .lastInsertRowid;

  await t.test('the row renders a plain button (not a data-confirm form) with the request URL on it', async () => {
    const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-name-tag-request-url="/main-admin/members/${memberId}/request-name-tag"`));
    assert.doesNotMatch(res.text, new RegExp(`<form[^>]*action="/main-admin/members/${memberId}/request-name-tag"`));
  });

  await t.test('a fetch()-style POST gets JSON back instead of a redirect, so the page never navigates', async () => {
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/main-admin/members/${memberId}/request-name-tag`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .set('X-CSRF-Token', csrfToken)
      .send();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const row = await db.prepare("SELECT archived FROM name_tag_requests WHERE member_id = ? AND request_type = 'new_tag'").get(memberId);
    assert.ok(row);
    assert.equal(Number(row.archived), 0);
  });

  await t.test('a plain (non-fetch) POST still redirects, unchanged from before', async () => {
    const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app).post(`/main-admin/members/${memberId}/request-name-tag`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/main-admin/members');
  });
});

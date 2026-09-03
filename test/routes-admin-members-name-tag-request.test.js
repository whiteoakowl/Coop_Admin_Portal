// Real request: "when clicking the icons to add that member to the name
// tags request log, if they are already on the log, it should say, this
// member is already on the name tags request log. and the popup closes."
// Covers routes/admin-members.js's GET /members pendingNameTagMemberIds
// computation and views/admin-members.ejs's two render branches for the
// per-row "Add to Name Tag Request Log" icon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-name-tag-request-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-name-tag-request-test-uploads-${process.pid}`);
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

async function login() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Members list Add-to-Name-Tag-Request-Log icon', async (t) => {
  const cookie = await login();

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Name Tag Request Member', 'name-tag-request-member', 'parent')").run()).lastInsertRowid;

  await t.test('with no pending request, the row shows the Add button', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-name-tag-request-url="/admin/members/${memberId}/request-name-tag"`));
    assert.doesNotMatch(res.text, /data-info-message="This member is already on the name tags request log\."/);
  });

  await t.test('POST request-name-tag queues an unarchived request and redirects for a plain (non-fetch) submit', async () => {
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app).post(`/admin/members/${memberId}/request-name-tag`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    const row = await db.prepare("SELECT archived FROM name_tag_requests WHERE member_id = ? AND request_type = 'new_tag'").get(memberId);
    assert.ok(row);
    assert.equal(Number(row.archived), 0);
  });

  await t.test('once pending, the row shows the info-only "already on the log" button instead', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, new RegExp(`data-name-tag-request-url="/admin/members/${memberId}/request-name-tag"`));
    assert.match(res.text, /data-info-message="This member is already on the name tags request log\."/);
  });

  await t.test('once the request is archived, the row goes back to showing the Add button', async () => {
    await db.prepare("UPDATE name_tag_requests SET archived = 1 WHERE member_id = ?").run(memberId);
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-name-tag-request-url="/admin/members/${memberId}/request-name-tag"`));
    assert.doesNotMatch(res.text, /data-info-message="This member is already on the name tags request log\."/);
  });

  await t.test('a fetch()-style POST (X-Requested-With: fetch) gets JSON back instead of a redirect, so the page never navigates', async () => {
    const secondMemberId = (
      await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Name Tag Request Member', 'fetch-name-tag-request-member', 'parent')").run()
    ).lastInsertRowid;
    const page = await request(app).get('/admin/members').set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/admin/members/${secondMemberId}/request-name-tag`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .set('X-CSRF-Token', csrfToken)
      .send();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const row = await db.prepare("SELECT archived FROM name_tag_requests WHERE member_id = ? AND request_type = 'new_tag'").get(secondMemberId);
    assert.ok(row);
  });
});

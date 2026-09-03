// Real request: "main admin portal, ... the trash can button is missing
// from next to each member. co-op admin portal has the correct symbols
// for each member." routes/main-admin-members.js's own POST /:id/delete
// already existed (previously only reachable from the Archive tab, per
// an earlier "archive first" request) - the live Members tab now also
// shows the same per-row trash-icon Delete button Co-op Admin's own
// Members list always shows, alongside the existing Archive icon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-delete-icon-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-delete-icon-test-uploads-${process.pid}`);
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);
  return { cookie, csrfToken };
}

test('the live Members tab shows a trash-icon Delete button per row, alongside Archive', async () => {
  const { cookie } = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Delete Icon Member', 'delete-icon-member', 'parent')").run()).lastInsertRowid;

  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const rowMatch = new RegExp(`<tr[^>]*>[\\s\\S]*?Delete Icon Member[\\s\\S]*?</tr>`).exec(res.text);
  assert.ok(rowMatch, 'expected to find this member\'s own row');
  const rowHtml = rowMatch[0];
  assert.match(rowHtml, new RegExp(`action="/main-admin/members/${memberId}/archive"`), 'Archive icon should still be there');
  assert.match(rowHtml, new RegExp(`action="/main-admin/members/${memberId}/delete"`), 'Delete icon should now also be there');
  assert.match(rowHtml, /icon-trash/);
  assert.match(rowHtml, /data-confirm="Permanently delete Delete Icon Member\?/);
});

test('deleting straight from the live Members tab works without archiving first', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Direct Delete Member', 'direct-delete-member', 'parent', 1)").run()).lastInsertRowid;

  const res = await request(app).post(`/main-admin/members/${memberId}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Deleted "Direct Delete Member"\./);

  const row = await db.prepare('SELECT 1 AS ok FROM members WHERE id = ?').get(memberId);
  assert.equal(row, undefined, 'the member should be gone entirely, not just archived');
});

test('the Archive tab still shows Reactivate + trash-icon Delete, unchanged', async () => {
  const { cookie } = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Archived Delete Icon Member', 'archived-delete-icon-member', 'parent', 0)").run()).lastInsertRowid;

  const res = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.equal(res.status, 200);
  const rowMatch = new RegExp(`<tr[^>]*>[\\s\\S]*?Archived Delete Icon Member[\\s\\S]*?</tr>`).exec(res.text);
  assert.ok(rowMatch);
  const rowHtml = rowMatch[0];
  assert.match(rowHtml, new RegExp(`action="/main-admin/members/${memberId}/unarchive"`));
  assert.match(rowHtml, new RegExp(`action="/main-admin/members/${memberId}/delete"`));
  assert.match(rowHtml, />Reactivate</);
});

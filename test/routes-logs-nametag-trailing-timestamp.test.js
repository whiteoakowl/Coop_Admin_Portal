// Real request: "name tags request log, add the date and timestamp to the
// end of the row, before the archive icon button." The row already led
// with a "Submitted" timestamp column - this repeats the same value in a
// second column right before the on-screen Archive button, so it's still
// visible without scrolling back to the row's left edge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-logs-nametag-trailing-timestamp-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-logs-nametag-trailing-timestamp-test-uploads-${process.pid}`);
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
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Name Tag Requests log repeats the submitted timestamp in a trailing column, right before Archive', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Trailing Timestamp Member', 'trailing-ts-member', 'parent')").run()).lastInsertRowid;
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'both', 'Test request')").run(memberId);

  const res = await request(app).get('/admin/logs?tab=nametag').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /<tr><th>Submitted<\/th><th>Name<\/th><th>Request<\/th><th>Day<\/th><th>Description<\/th><th>Submitted<\/th><th><\/th><\/tr>/);

  const rowMatch = /<tr>\s*<td>([^<]+)<\/td>\s*<td>Trailing Timestamp Member<\/td>[\s\S]*?<\/tr>/.exec(res.text);
  assert.ok(rowMatch, 'expected to find the request row');
  const rowHtml = rowMatch[0];
  const timestamp = rowMatch[1];

  const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
  assert.equal(cells.length, 7);
  assert.equal(cells[0], timestamp);
  assert.equal(cells[5], timestamp);
  assert.match(cells[6], /Archive/);
});

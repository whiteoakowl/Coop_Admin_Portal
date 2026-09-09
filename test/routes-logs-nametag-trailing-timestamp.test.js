// A real request: "name tag request log columns in this order. archive
// icon first, name, description, dates, time, day, request." Supersedes
// this file's own earlier "repeat the timestamp before Archive" layout -
// Archive moving to the front removes the reason that trailing duplicate
// column existed (staying visible without scrolling back to the left
// edge), and the single combined "Submitted" timestamp column is now two
// separate Date/Time columns (utils/dates.js's formatDateAndTime).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-logs-nametag-column-order-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-logs-nametag-column-order-test-uploads-${process.pid}`);
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

test('Name Tag Requests log columns are: archive icon, Name, Description, Date, Time, Day, Request', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Column Order Member', 'column-order-member', 'parent')").run()).lastInsertRowid;
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'both', 'Test request')").run(memberId);

  const res = await request(app).get('/admin/logs?tab=nametag').set('Cookie', cookie);
  assert.equal(res.status, 200);

  assert.match(res.text, /<tr><th class="no-print"><\/th><th>Name<\/th><th>Description<\/th><th>Date<\/th><th>Time<\/th><th>Day<\/th><th>Request<\/th><\/tr>/);

  const rowMatch = /<tr>\s*<td class="no-print">[\s\S]*?<\/td>\s*<td>Column Order Member<\/td>[\s\S]*?<\/tr>/.exec(res.text);
  assert.ok(rowMatch, 'expected to find the request row');
  const rowHtml = rowMatch[0];

  const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
  assert.equal(cells.length, 7);
  assert.match(cells[0], /Archive/, 'first column should be the archive action');
  assert.equal(cells[1], 'Column Order Member');
  assert.equal(cells[2], 'Test request');
  assert.match(cells[3], /\d{1,2}\/\d{1,2}\/\d{4}/, 'Date column should be a date');
  assert.match(cells[4], /\d{1,2}:\d{2}/, 'Time column should be a time');
  assert.equal(cells[5], 'Both');
  assert.equal(cells[6], 'New Name Tag');
});

test('the print-only table drops the archive column but keeps the same Name/Description/Date/Time/Day/Request order', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Column Member', 'print-column-member', 'parent')").run()).lastInsertRowid;
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'Lost mine')").run(memberId);

  const res = await request(app).get('/admin/logs?tab=nametag').set('Cookie', cookie);
  assert.match(res.text, /<tr><th>Name<\/th><th>Description<\/th><th>Date<\/th><th>Time<\/th><th>Day<\/th><th>Request<\/th><\/tr>/);
});

// Real HTTP-level coverage for the Members list's pagination (Phase 4
// audit item, utils/pagination.js). The one thing worth pinning down at
// the route level rather than just in the pure utils/pagination.js unit
// tests: the print table must always render every filtered member
// regardless of which page is open on screen - a silent regression there
// (printing only the current page) wouldn't be caught by testing the
// pagination math alone. Boots the real app (server.js) against a
// throwaway DB, same pattern as the other test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-members-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-members-pagination-test-uploads-${process.pid}`);
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

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('Members list pagination', async (t) => {
  const cookie = await loginAsAdmin();
  const insert = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')");
  for (let i = 1; i <= 65; i++) {
    insert.run(`Pagination Kid ${String(i).padStart(2, '0')}`, `pagination-kid-${i}`);
  }

  await t.test('page 1 shows the first 50 on screen but all 65 in the print table', async () => {
    const res = await request(app).get('/admin/members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(countOccurrences(res.text, 'member-name-link'), 50, 'interactive table shows only the current page');
    // The print table's name cell is a plain "<td>Name</td>" with no other
    // markup around it (see admin-members.ejs's .members-print-table), so
    // this count is print-table rows only, independent of the interactive
    // table's per-row aria-labels/dialogs that also mention each name.
    assert.equal(countOccurrences(res.text, '<td>Pagination Kid'), 65, 'print table always shows every filtered member');
    assert.match(res.text, /Showing 1&ndash;50 of 65/);
    assert.match(res.text, /Page 1 of 2/);
  });

  await t.test('page 2 shows the remaining 15 on screen, still all 65 in the print table', async () => {
    const res = await request(app).get('/admin/members?page=2').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(countOccurrences(res.text, 'member-name-link'), 15);
    assert.equal(countOccurrences(res.text, '<td>Pagination Kid'), 65, 'print table is unaffected by which page is open');
    assert.match(res.text, /Showing 51&ndash;65 of 65/);
  });

  await t.test('a page past the end clamps to the last real page rather than rendering empty', async () => {
    const res = await request(app).get('/admin/members?page=999').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Page 2 of 2/);
    assert.equal(countOccurrences(res.text, 'member-name-link'), 15);
  });

  await t.test('the Next link preserves the active type filter', async () => {
    const res = await request(app).get('/admin/members?type=student').set('Cookie', cookie);
    assert.match(res.text, /href="\/admin\/members\?type=student&amp;page=2"/);
  });

  await t.test('a small filtered result set renders no pagination bar at all', async () => {
    const res = await request(app).get('/admin/members?type=parent').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /pagination-bar/);
  });
});

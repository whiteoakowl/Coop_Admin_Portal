// Real HTTP-level coverage for the Library Catalog tab's pagination
// (Phase 4 audit item, part 3 - utils/pagination.js). Simpler than
// Members/Logs: the Catalog tab has no Print button at all (confirmed by
// reading views/admin-library.ejs), so there's no separate print-only
// table to keep in sync - just the paginated screen table itself. Boots
// the real app (server.js) against a throwaway DB, same pattern as the
// other test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-library-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-library-pagination-test-uploads-${process.pid}`);
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

test.before(async () => {
  await app.ready;
  const insert = db.prepare('INSERT INTO library_items (title, barcode) VALUES (?, ?)');
  for (let i = 1; i <= 65; i++) {
    await insert.run(`Library Book ${String(i).padStart(2, '0')}`, `lib-book-${i}`);
  }
  await db.prepare("INSERT INTO library_item_types (name) VALUES ('Book')").run();
  // 55 of the 65 are typed 'Book' - enough to still paginate under the
  // filter, so the Next-link test below actually exercises a real Next
  // link rather than a single-page result with nothing to click.
  await db.prepare("UPDATE library_items SET type = 'Book' WHERE id <= 55").run();
});

test('Library Catalog tab pagination', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('page 1 shows the first 50 items', async () => {
    const res = await request(app).get('/admin/library?tab=titles').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(countOccurrences(res.text, '<td>Library Book'), 50);
    assert.match(res.text, /Showing 1&ndash;50 of 65/);
    assert.match(res.text, /Page 1 of 2/);
  });

  await t.test('page 2 shows the remaining 15 items', async () => {
    const res = await request(app).get('/admin/library?tab=titles&page=2').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(countOccurrences(res.text, '<td>Library Book'), 15);
    assert.match(res.text, /Showing 51&ndash;65 of 65/);
  });

  await t.test('an out-of-range page clamps to the last real page', async () => {
    const res = await request(app).get('/admin/library?tab=titles&page=999').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Page 2 of 2/);
  });

  await t.test('the Next link preserves the active type filter', async () => {
    const res = await request(app).get('/admin/library?tab=titles&type=Book').set('Cookie', cookie);
    assert.equal(countOccurrences(res.text, '<td>Library Book'), 50, '55 Book-typed items, page 1 still shows 50');
    assert.match(res.text, /Showing 1&ndash;50 of 55/);
    assert.match(res.text, /href="\/admin\/library\?tab=titles&amp;type=Book&amp;page=2"/);
  });

  await t.test('a filtered result set under one page renders no pagination bar', async () => {
    const res = await request(app).get('/admin/library?tab=titles&type=nonexistent-type').set('Cookie', cookie);
    assert.doesNotMatch(res.text, /pagination-bar/);
  });

  await t.test('other Library tabs are unaffected - no pagination bar appears on Check In', async () => {
    const res = await request(app).get('/admin/library?tab=checkin').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /pagination-bar/);
  });
});

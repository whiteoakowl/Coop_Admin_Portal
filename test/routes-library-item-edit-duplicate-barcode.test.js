// Real bug: POSTing /admin/library/items/:id/edit with a barcode that
// another catalog item already uses hit library_items' own UNIQUE
// constraint on barcode and 500'd instead of showing a friendly error
// (the /new route already guarded this with findItemByBarcode, /edit
// did not). Boots the real app (server.js) against a throwaway DB, same
// pattern as the other test/routes-*.test.js files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-library-item-edit-dup-barcode-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-library-item-edit-dup-barcode-test-uploads-${process.pid}`);
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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/library?tab=titles').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let itemAId;
let itemBId;

test.before(async () => {
  await app.ready;
  itemAId = (await db.prepare('INSERT INTO library_items (title, barcode) VALUES (?, ?) RETURNING id').get('Book A', 'lib-a')).id;
  itemBId = (await db.prepare('INSERT INTO library_items (title, barcode) VALUES (?, ?) RETURNING id').get('Book B', 'lib-b')).id;
});

test('Library Catalog edit guards against duplicate barcodes', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('editing an item to a barcode another item already uses shows a friendly error, not a 500', async () => {
    const res = await request(app)
      .post(`/admin/library/items/${itemAId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Book A', barcode: 'lib-b', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    const unchanged = await db.prepare('SELECT barcode FROM library_items WHERE id = ?').get(itemAId);
    assert.equal(unchanged.barcode, 'lib-a', 'barcode must not have changed');
  });

  await t.test('re-saving an item with its own unchanged barcode still works (the inline type-change form)', async () => {
    const res = await request(app)
      .post(`/admin/library/items/${itemAId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Book A', barcode: 'lib-a', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
    const row = await db.prepare('SELECT title, barcode FROM library_items WHERE id = ?').get(itemAId);
    assert.equal(row.barcode, 'lib-a');
  });

  await t.test('editing an item to a genuinely new barcode succeeds', async () => {
    const res = await request(app)
      .post(`/admin/library/items/${itemBId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'Book B', barcode: 'lib-b-new', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);
    const row = await db.prepare('SELECT barcode FROM library_items WHERE id = ?').get(itemBId);
    assert.equal(row.barcode, 'lib-b-new');
  });
});

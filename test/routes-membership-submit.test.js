// Coverage for POST /membership (routes/membership.js), added while
// converting it to async/await as part of the Supabase migration (see
// MIGRATION.md) - it had no test coverage before this. Runs against the
// still-live SQLite backend (await on a non-Promise value is a
// transparent pass-through), so this suite doubles as proof the
// conversion didn't change behavior. Specifically locks in the
// forEach -> for-of change for inserting each child: forEach can't be
// awaited, so a naive async conversion that kept it would silently race
// every child insert instead of running them in order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `membership-submit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `membership-submit-test-uploads-${process.pid}`);
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

test('POST /membership', async (t) => {
  const cookie = await loginAsAdmin();

  await t.test('a submission with two children saves the request and both children, in order', async () => {
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({
        parent1FirstName: 'Pat',
        parent1LastName: 'Guardian',
        parent1Email: 'pat@example.com',
        'children[0][firstName]': 'First',
        'children[0][lastName]': 'Kid',
        'children[1][firstName]': 'Second',
        'children[1][lastName]': 'Kid',
      });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const request_ = db.prepare('SELECT * FROM membership_requests WHERE parent1_email = ?').get('pat@example.com');
    assert.ok(request_);
    const children = db
      .prepare('SELECT first_name, last_name FROM membership_request_children WHERE request_id = ? ORDER BY id')
      .all(request_.id);
    assert.deepEqual(
      children.map((c) => c.first_name),
      ['First', 'Second']
    );
  });

  await t.test('missing parent info is rejected, nothing saved', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM membership_requests').get().c;
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({ parent1FirstName: '', parent1LastName: 'Guardian', parent1Email: 'x@example.com' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM membership_requests').get().c, before);
  });

  await t.test('no children is rejected, nothing saved', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM membership_requests').get().c;
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({ parent1FirstName: 'Pat', parent1LastName: 'Guardian', parent1Email: 'nokids@example.com' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM membership_requests').get().c, before);
  });
});

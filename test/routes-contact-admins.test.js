// Real HTTP-level coverage for routes/contact-admins.js - written while
// converting this route to async/await as part of the Supabase migration
// (see MIGRATION.md), which had no test coverage before this. Runs
// against the still-live SQLite backend (the same as every other
// *.test.js file) - the conversion itself is a no-op against SQLite
// (await on a non-Promise value is a transparent pass-through), so this
// suite doubles as proof the conversion didn't change behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `contact-admins-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `contact-admins-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/contact-admins').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('GET /contact-admins sorts leadership contacts case-insensitively by role (LOWER(role), not COLLATE NOCASE)', async () => {
  db.prepare('DELETE FROM leadership_contacts').run();
  const insert = db.prepare('INSERT INTO leadership_contacts (role, name, email, position) VALUES (?, ?, ?, 0)');
  insert.run('zebra role', 'Z Person', 'z@example.com');
  insert.run('Apple Role', 'A Person', 'a@example.com');
  insert.run('banana role', 'B Person', 'b@example.com');

  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/contact-admins').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const order = ['Apple Role', 'banana role', 'zebra role'].map((r) => res.text.indexOf(r));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'expected case-insensitive alphabetical order: Apple, banana, zebra');
});

test('POST /contact-admins', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('a complete submission is saved and redirects with a notice', async () => {
    const res = await request(app)
      .post('/contact-admins')
      .set('Cookie', cookie)
      .type('form')
      .send({ leadershipTeam: 'Director', senderEmail: 'parent@example.com', title: 'Question', message: 'Hello there', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const saved = db.prepare('SELECT * FROM contact_admin_messages WHERE sender_email = ?').get('parent@example.com');
    assert.ok(saved);
    assert.equal(saved.leadership_team, 'Director');
    assert.equal(saved.title, 'Question');
    assert.equal(saved.message, 'Hello there');
  });

  await t.test('a submission missing a required field is rejected, not saved', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM contact_admin_messages').get().c;
    const res = await request(app)
      .post('/contact-admins')
      .set('Cookie', cookie)
      .type('form')
      .send({ leadershipTeam: '', senderEmail: 'parent@example.com', title: 'Question', message: 'Hello there', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    const after = db.prepare('SELECT COUNT(*) AS c FROM contact_admin_messages').get().c;
    assert.equal(after, before, 'nothing should have been inserted');
  });
});

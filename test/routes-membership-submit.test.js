// Coverage for POST /membership (routes/membership.js) - a real request:
// "Add member and membership request form should be the same ... however
// it will still create individual profiles." /membership now shares
// views/member-intake-form.ejs and utils/memberIntake.js with Main
// Admin's and Co-op Admin's own Add Member forms, and creates real
// `members` rows directly rather than a PENDING membership_requests/
// membership_request_children row for later review - see routes/
// membership.js's own header comment for why that staging step never
// added real review to begin with (every entry point here is already
// admin-gated).
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

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/membership').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('POST /membership', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('a submission with a parent and two children creates individual member profiles for each, in order', async () => {
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({
        newFamilyName: 'Guardian',
        'parents[0][name]': 'Pat Guardian',
        'parents[0][email]': 'pat@example.com',
        'children[0][name]': 'First Kid',
        'children[1][name]': 'Second Kid',
        _csrf: csrfToken,
      });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const parent = await db.prepare("SELECT * FROM members WHERE email = 'pat@example.com'").get();
    assert.ok(parent, 'expected a real member row, not just a pending request');
    assert.equal(parent.member_type, 'parent');

    const family = await db.prepare('SELECT * FROM families WHERE id = ?').get(parent.family_id);
    assert.equal(family.name, 'Guardian');

    const children = (await db.prepare("SELECT name FROM members WHERE family_id = ? AND member_type = 'student' ORDER BY id").all(parent.family_id)).map(
      (c) => c.name
    );
    assert.deepEqual(children, ['First Kid', 'Second Kid']);
  });

  await t.test('missing parent info is rejected, nothing saved', async () => {
    const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM members').get()).c);
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({ newFamilyName: 'NoParent', 'children[0][name]': 'Orphan Kid', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM members').get()).c), before);
  });

  await t.test('no students is rejected, nothing saved', async () => {
    const before = Number((await db.prepare('SELECT COUNT(*) AS c FROM members').get()).c);
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({ newFamilyName: 'NoKids', 'parents[0][name]': 'Pat NoKids', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS c FROM members').get()).c), before);
  });

  await t.test('no PENDING membership_requests row is ever created - the form creates real members directly', async () => {
    const count = Number((await db.prepare('SELECT COUNT(*) AS c FROM membership_requests').get()).c);
    assert.equal(count, 0);
  });
});

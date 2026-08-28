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

  // A real request: "you can only have one primary parent per family."
  await t.test('checking Primary Parent on more than one parent block in the same submission leaves only the last one primary', async () => {
    const res = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({
        newFamilyName: 'TwoPrimaries',
        'parents[0][name]': 'First Parent',
        'parents[0][isPrimaryParent]': '1',
        'parents[1][name]': 'Second Parent',
        'parents[1][isPrimaryParent]': '1',
        'children[0][name]': 'Kid',
        _csrf: csrfToken,
      });
    assert.equal(res.status, 302);

    const first = await db.prepare("SELECT is_primary_parent FROM members WHERE name = 'First Parent'").get();
    const second = await db.prepare("SELECT is_primary_parent FROM members WHERE name = 'Second Parent'").get();
    assert.equal(Number(first.is_primary_parent), 0, 'the earlier-inserted parent must be cleared once a later one is also marked primary');
    assert.equal(Number(second.is_primary_parent), 1);
  });

  await t.test('a new primary parent added to a family that already has one clears the old one', async () => {
    const before = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({
        newFamilyName: 'ExistingPrimary',
        'parents[0][name]': 'Original Primary',
        'parents[0][isPrimaryParent]': '1',
        'children[0][name]': 'Kid',
        _csrf: csrfToken,
      });
    assert.equal(before.status, 302);
    const family = await db.prepare("SELECT family_id FROM members WHERE name = 'Original Primary'").get();

    const after = await request(app)
      .post('/membership')
      .set('Cookie', cookie)
      .type('form')
      .send({
        familyId: String(family.family_id),
        'parents[0][name]': 'New Primary',
        'parents[0][isPrimaryParent]': '1',
        'children[0][name]': 'Second Kid',
        _csrf: csrfToken,
      });
    assert.equal(after.status, 302);

    const original = await db.prepare("SELECT is_primary_parent FROM members WHERE name = 'Original Primary'").get();
    const newPrimary = await db.prepare("SELECT is_primary_parent FROM members WHERE name = 'New Primary'").get();
    assert.equal(Number(original.is_primary_parent), 0);
    assert.equal(Number(newPrimary.is_primary_parent), 1);
  });
});

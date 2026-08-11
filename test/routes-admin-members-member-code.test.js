// Real HTTP-level coverage for a feature this session: every member now
// gets a permanent, auto-generated 6-digit member_code at creation
// (utils/members.js's generateMemberCode), with barcode set to match it -
// see db/schema.sql's member_code column comment for the full context on
// why (barcode used to just be the member's own name, which made a
// printed barcode's width vary with how long that name was).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-member-code-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-member-code-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('POST /admin/members/new assigns a 6-digit member_code, and barcode matches it', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('a fresh member gets a member_code, not a name-based barcode', async () => {
    const res = await request(app)
      .post('/admin/members/new')
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Priya Patel', memberType: 'student', _csrf: csrfToken });
    assert.equal(res.status, 302);

    const row = db.prepare('SELECT barcode, member_code FROM members WHERE name = ?').get('Priya Patel');
    assert.match(row.member_code, /^\d{6}$/);
    assert.equal(row.barcode, row.member_code);
  });

  await t.test('two members created back to back never collide on member_code', async () => {
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Sam Rivera', memberType: 'student', _csrf: csrfToken });
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Jordan Kim', memberType: 'student', _csrf: csrfToken });
    const codes = db.prepare("SELECT member_code FROM members WHERE name IN ('Sam Rivera', 'Jordan Kim')").all().map((r) => r.member_code);
    assert.equal(codes.length, 2);
    assert.notEqual(codes[0], codes[1]);
  });
});

test('editing a member never changes their member_code/barcode, even when their name changes', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Original Name', memberType: 'student', _csrf: csrfToken });
  const before = db.prepare('SELECT id, member_code, barcode FROM members WHERE name = ?').get('Original Name');

  await t.test('renaming the member on their edit page keeps the same member_code and barcode', async () => {
    const res = await request(app)
      .post(`/admin/members/${before.id}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Renamed Person', memberType: 'student', _csrf: csrfToken });
    assert.equal(res.status, 302);

    const after = db.prepare('SELECT member_code, barcode FROM members WHERE id = ?').get(before.id);
    assert.equal(after.member_code, before.member_code, "the member's permanent ID must not change just because they were renamed");
    assert.equal(after.barcode, before.barcode);
  });
});

test('the barcode-only print sheet renders the member_code-based barcode value', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Barcode Check Kid', memberType: 'student', _csrf: csrfToken });
  const member = db.prepare('SELECT id, member_code FROM members WHERE name = ?').get('Barcode Check Kid');

  await t.test('the printed barcode SVG carries the member_code as its data-barcode-value, not the name', async () => {
    const res = await request(app)
      .post('/admin/name-tag/print-barcodes')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: member.id, _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`data-barcode-value="${member.member_code}"`));
    assert.doesNotMatch(res.text, /data-barcode-value="Barcode Check Kid"/);
  });
});

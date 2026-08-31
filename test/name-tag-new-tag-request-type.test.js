// Real request: "co-op admin portal name tag request form. options are
// schedule change and lost name tag. add new name tag as option." Covers
// the new 'new_tag' request type end-to-end: the public form renders it as
// a third radio option, a submission with it is accepted and stored, and
// every admin-facing surface that labels request_type (Co-op Admin's
// Design/Print Requests tab and Logs tab, Main Admin's Name Tags Requests
// tab) shows it as "New Name Tag" rather than falling back to the raw
// 'new_tag' value.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-new-tag-request-type-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-new-tag-request-type-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('public Name Tag form offers New Name Tag as a third radio option, alongside Lost Name Tag and Schedule Change', async () => {
  const res = await request(app).get('/name-tag');
  assert.equal(res.status, 200);
  assert.match(res.text, /<input type="radio" name="requestType" value="new_tag"[^>]*required[^>]*\/>\s*New Name Tag/);
  assert.match(res.text, /value="lost_tag"/);
  assert.match(res.text, /value="schedule_change"/);
});

test('a submission with requestType=new_tag is accepted and stored', async () => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Casey New', 'Casey New', 'student')")
    .run();

  const res = await request(app)
    .post('/name-tag/submit')
    .type('form')
    .send({ memberId: String(memberId), memberIds: [String(memberId)], requestType: 'new_tag', day: 'monday' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Request submitted for Casey New/);

  const row = await db.prepare('SELECT request_type FROM name_tag_requests WHERE member_id = ?').get(memberId);
  assert.equal(row.request_type, 'new_tag');
});

test('Co-op Admin Design/Print Requests tab and Logs tab both label it "New Name Tag"', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Riley Newtag', 'Riley Newtag', 'student')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'wednesday', 'testing')").run(memberId);

  await t.test('Design/Print hub Requests tab', async () => {
    const res = await request(app).get('/admin/design?tab=requests').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Riley Newtag/);
    assert.match(res.text, /New Name Tag/);
  });

  await t.test('original Logs tab', async () => {
    const res = await request(app).get('/admin/logs?tab=nametag').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Riley Newtag/);
    assert.match(res.text, /New Name Tag/);
  });

  await t.test('Co-op Admin Name Tags Requests tab', async () => {
    const res = await request(app).get('/admin/name-tag?tab=requests').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Riley Newtag/);
    assert.match(res.text, /New Name Tag/);
  });
});

test('Main Admin Name Tags Requests tab also labels it "New Name Tag"', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Morgan Newtag', 'Morgan Newtag', 'parent')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'new_tag', 'both', NULL)").run(memberId);

  const res = await request(app).get('/main-admin/name-tags?tab=requests').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Morgan Newtag/);
  assert.match(res.text, /New Name Tag/);
});

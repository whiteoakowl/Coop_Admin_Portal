// Coverage for the Design/Print hub's Requests tab (routes/admin-design.js)
// - a second, independent way to reach Name Tag Requests alongside the
// original Logs tab (/admin/logs?tab=nametag, unchanged - see
// test/routes-logs-pagination.test.js), not a replacement for it. Both
// read/write the same name_tag_requests table, so this locks in that an
// archive done from one location is visible from the other too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-design-requests-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-design-requests-test-uploads-${process.pid}`);
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

test('Design/Print hub Requests tab', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jordan Requestor', 'Jordan Requestor', 'student')")
    .run();
  const { lastInsertRowid: requestId } = await db
    .prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'testing')")
    .run(memberId);

  await t.test('shows as a tab alongside Design and Print, and lists the request', async () => {
    const res = await request(app).get('/admin/design?tab=requests').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<a class="view-tab active" href="\/admin\/design\?tab=requests">Requests<\/a>/);
    assert.match(res.text, /Jordan Requestor/);
    assert.match(res.text, /Lost Name Tag/);
  });

  await t.test('archiving from the Design/Print hub is reflected on the original Logs tab too - same underlying data', async () => {
    const page = await request(app).get('/admin/design?tab=requests').set('Cookie', cookie);
    const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

    const archiveRes = await request(app)
      .post(`/admin/design/requests/${requestId}/archive`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(archiveRes.status, 302);
    assert.match(archiveRes.headers.location, /\/admin\/design\?tab=requests/);

    const designRes = await request(app).get('/admin/design?tab=requests').set('Cookie', cookie);
    assert.doesNotMatch(designRes.text, /Jordan Requestor/, 'archived off the default (non-archived) view');

    const logsRes = await request(app).get('/admin/logs?tab=nametag&archived=1').set('Cookie', cookie);
    assert.equal(logsRes.status, 200);
    assert.match(logsRes.text, /Jordan Requestor/, 'the same archive is visible from the original Logs tab');
  });

  await t.test('export.csv includes the request', async () => {
    const res = await request(app).get('/admin/design/requests/export.csv?archived=1').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Jordan Requestor/);
  });
});

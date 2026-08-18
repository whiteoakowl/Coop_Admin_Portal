// Real HTTP-level coverage for Settings' new "Admin & Leaders" tab (routes/
// admin.js's POST /settings/admin-positions and /settings/admin-positions/
// :id/delete, backed by utils/adminPositions.js). A real user request:
// "Under settings, add a tab for admin/leaders. Under this tab you can add
// a list of admin positions. This list will then appear on the member form
// as a choice in the admin position dropdown menu."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-settings-admin-positions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-settings-admin-positions-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/settings?tab=leaders').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Settings: Admin & Leaders tab', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('the tab is offered and starts empty', async () => {
    const res = await request(app).get('/admin/settings?tab=leaders').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Admin &amp; Leaders/);
    assert.match(res.text, /No admin positions added yet\./);
  });

  await t.test('adding a position lists it', async () => {
    // routes/admin.js's Settings POST handlers render the page directly
    // (via renderSettings) rather than redirecting - same convention the
    // existing Class Check-In PIN tab already uses, so a successful add
    // is a 200 with the new position already in the response body, not a
    // 302.
    const res = await request(app)
      .post('/admin/settings/admin-positions')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
    assert.doesNotMatch(res.text, /No admin positions added yet\./);
  });

  await t.test('the new position shows up in the member form dropdown', async () => {
    const res = await request(app).get('/admin/members/new').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
  });

  await t.test('adding a duplicate title is a no-op, not an error', async () => {
    const res = await request(app)
      .post('/admin/settings/admin-positions')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    const rows = await db.prepare('SELECT id FROM admin_positions WHERE title = ?').all('President');
    assert.equal(rows.length, 1, 'still exactly one "President" row, not duplicated');
  });

  await t.test('deleting a position removes it from the list', async () => {
    const listPage = await request(app).get('/admin/settings?tab=leaders').set('Cookie', cookie);
    const idMatch = /\/admin\/settings\/admin-positions\/(\d+)\/delete/.exec(listPage.text);
    assert.ok(idMatch, 'expected a delete form with the position id in its action');
    const res = await request(app)
      .post(`/admin/settings/admin-positions/${idMatch[1]}/delete`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /No admin positions added yet\./);
  });
});

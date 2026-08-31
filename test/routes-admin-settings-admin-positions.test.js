// Real HTTP-level coverage for the "Admins" tab (routes/main-admin.js's
// POST /admins/positions and /admins/positions/:id/delete, backed by
// utils/adminPositions.js). Originally "Admin & Leaders" on Co-op
// Admin's own Settings, later just "Admins" there - a real request then
// moved the whole tab to Main Admin's Settings: "co-op admin portal.
// settings gear, admins tab. this tab should be located under the main
// admin portal settings gear as a tab. it should not be on co-op admin
// portal."
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Main Admin Settings: Admins tab', async (t) => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  await t.test('the tab is offered and starts empty', async () => {
    const res = await request(app).get('/main-admin/admins').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, />Admins<\/a>/);
    assert.match(res.text, /No admin positions added yet\./);
  });

  await t.test('adding a position lists it', async () => {
    const res = await request(app)
      .post('/main-admin/admins/positions')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
    assert.doesNotMatch(res.text, /No admin positions added yet\./);
  });

  await t.test('the new position shows up in the (Co-op Admin) member edit form dropdown', async () => {
    // Admin Positions still lives in utils/adminPositions.js, shared by
    // both portals' member data - only the Settings UI for MANAGING the
    // list of positions moved to Main Admin. Co-op Admin's own member
    // edit form (views/partials/member-form-fields.ejs) still shows an
    // existing Admin's position checkboxes (just never lets anyone
    // become Admin from there in the first place - see that partial's
    // own comment).
    const coopCookie = await loginAsCoopAdmin();
    const coopPage = await request(app).get('/admin/members/new').set('Cookie', coopCookie);
    const coopCsrf = extractCsrf(coopPage.text);
    await request(app)
      .post('/admin/members/new')
      .set('Cookie', coopCookie)
      .type('form')
      .send({
        newFamilyName: 'PositionDropdownCheck',
        'parents[0][name]': 'Position Dropdown Parent',
        'children[0][name]': 'Position Dropdown Kid',
        _csrf: coopCsrf,
      });
    const member = await db.prepare("SELECT id FROM members WHERE name = 'Position Dropdown Parent'").get();
    assert.ok(member, 'the new parent should have been created');

    const res = await request(app).get(`/admin/members/${member.id}/edit`).set('Cookie', coopCookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
  });

  await t.test('adding a duplicate title is a no-op, not an error', async () => {
    const res = await request(app)
      .post('/main-admin/admins/positions')
      .set('Cookie', cookie)
      .type('form')
      .send({ title: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    const rows = await db.prepare('SELECT id FROM admin_positions WHERE title = ?').all('President');
    assert.equal(rows.length, 1, 'still exactly one "President" row, not duplicated');
  });

  await t.test('deleting a position removes it from the list', async () => {
    const listPage = await request(app).get('/main-admin/admins').set('Cookie', cookie);
    const idMatch = /\/main-admin\/admins\/positions\/(\d+)\/delete/.exec(listPage.text);
    assert.ok(idMatch, 'expected a delete form with the position id in its action');
    const res = await request(app)
      .post(`/main-admin/admins/positions/${idMatch[1]}/delete`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /No admin positions added yet\./);
  });
});

test('Co-op Admin Settings no longer offers an Admins tab', async () => {
  const cookie = await loginAsCoopAdmin();
  const res = await request(app).get('/admin/settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /tab=leaders/);
  assert.doesNotMatch(res.text, />Admins<\/a>/);

  // The old tab query param should just fall back to the default tab,
  // not error or still render admin-position content.
  const oldTabRes = await request(app).get('/admin/settings?tab=leaders').set('Cookie', cookie);
  assert.equal(oldTabRes.status, 200);
  assert.doesNotMatch(oldTabRes.text, /Add Admin Position/);
});

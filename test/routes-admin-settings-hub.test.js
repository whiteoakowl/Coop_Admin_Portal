// A real request: "change co-op admin settings gear to cards for each
// tab like main admin portal settings gear." GET /admin/settings with
// no ?tab= now renders a card-grid hub (same .team-card-grid/.team-
// info-card shape as Main Admin's own /main-admin/settings) instead of
// silently defaulting to the Username/Password tab, and each individual
// tab page gets a "Back to Settings Menu" link instead of the old
// 4/5-tab strip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-settings-hub-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-settings-hub-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

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

test('GET /admin/settings with no tab renders a card for every settings destination, not the old tab strip', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<h1>Settings<\/h1>/);
  assert.match(res.text, /<div class="team-card-grid">/);

  assert.match(res.text, /href="\/admin\/settings\?tab=account"[^]*?Username\/Password/);
  assert.match(res.text, /href="\/admin\/settings\?tab=classcheckin"[^]*?Class Check-In PIN/);
  assert.match(res.text, /href="\/admin\/settings\?tab=kiosk"[^]*?Kiosk/);
  assert.match(res.text, /href="\/admin\/settings\?tab=quicklinks"[^]*?Quick Links/);
  assert.match(res.text, /href="\/admin\/settings\?tab=install"[^]*?Install App/);

  assert.doesNotMatch(res.text, /class="view-tabs no-print"/, 'the old tab strip should be gone');
});

test('each settings tab page shows a Back to Settings Menu link instead of the tab strip', async () => {
  const cookie = await loginAsAdmin();
  for (const tab of ['account', 'classcheckin', 'kiosk', 'quicklinks', 'install']) {
    const res = await request(app).get(`/admin/settings?tab=${tab}`).set('Cookie', cookie);
    assert.equal(res.status, 200, `tab=${tab}`);
    assert.match(res.text, /<a href="\/admin\/settings">&larr; Back to Settings Menu<\/a>/, `tab=${tab}`);
    assert.doesNotMatch(res.text, /class="view-tabs no-print"/, `tab=${tab}`);
  }
});

test('a saved notice (e.g. after updating the username) still renders that tab\'s own panel, not the hub', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/settings?tab=account').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post('/admin/settings/username')
    .set('Cookie', cookie)
    .type('form')
    .send({ newUsername: 'renamedtestadmin', _csrf: csrfToken });
  assert.equal(res.status, 200);
  assert.match(res.text, /Username updated\./);
  assert.match(res.text, /<a href="\/admin\/settings">&larr; Back to Settings Menu<\/a>/);
  assert.doesNotMatch(res.text, /<div class="team-card-grid">/);
});

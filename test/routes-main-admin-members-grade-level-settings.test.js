// Coverage for the Main Admin Portal > Members > Settings tab's new
// Grade Level Settings sub-tab (routes/main-admin-members.js's POST
// /settings/grade-levels, utils/gradeLevelSettings.js) - a real request:
// "Under member settings add a tab called grade level settings. Here is
// a list of graded levels. Next to each grade level is a date picker and
// another column for age. Clean rows. Each row will say, if student is
// (age), by (date/calendar picker), then they will be in (grade
// level)." Also covers the surrounding "All of these member settings
// are currently on one page. They should be moved to their own tabs" -
// the Settings tab's own nested settingsTab sub-tabs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-grade-level-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-grade-level-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

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
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Settings tab shows the 5 nested sub-tabs, Grade Level Settings default/active, one row per grade level', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.match(page.text, /Grade Level Settings/);
  assert.match(page.text, /Membership Fee &amp; Payment/);
  assert.match(page.text, /Membership Form Fields/);
  assert.match(page.text, /Approval\/Denial/);
  assert.match(page.text, /Policy Handbook/);
  // Grade Level Settings is the default sub-tab and its own rows render.
  assert.match(page.text, /class="view-tab active" href="\/main-admin\/members\?tab=settings&settingsTab=grade-levels">Grade Level Settings/);
  assert.match(page.text, /name="gradeLevel" value="Kindergarten"/);
  assert.match(page.text, /name="gradeLevel" value="1st"/);
  // The other sub-tabs' content isn't rendered until selected.
  assert.doesNotMatch(page.text, /Approval Letter/);
});

test('Switching settingsTab shows only that section', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings&settingsTab=approval-denial').set('Cookie', cookie);
  assert.match(page.text, /class="view-tab active" href="\/main-admin\/members\?tab=settings&settingsTab=approval-denial">Approval\/Denial/);
  assert.match(page.text, /Approval Letter/);
  assert.match(page.text, /Denial Letter/);
  assert.doesNotMatch(page.text, /name="gradeLevel"/);
});

test('POST /main-admin/members/settings/grade-levels saves every row and redirects back to that sub-tab', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  const gradeLevels = [...page.text.matchAll(/name="gradeLevel" value="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(gradeLevels.includes('Kindergarten'));
  assert.ok(gradeLevels.includes('12th'));

  const age = gradeLevels.map((g) => (g === 'Kindergarten' ? '5' : g === '1st' ? '6' : ''));
  const cutoffDate = gradeLevels.map((g) => (g === 'Kindergarten' ? '2026-09-01' : g === '1st' ? '2026-09-01' : ''));

  const res = await request(app)
    .post('/main-admin/members/settings/grade-levels')
    .set('Cookie', cookie)
    .type('form')
    .send({ gradeLevel: gradeLevels, age, cutoffDate, _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /settingsTab=grade-levels/);
  assert.match(res.headers.location, /notice=/);

  const reloaded = await request(app).get('/main-admin/members?tab=settings&settingsTab=grade-levels').set('Cookie', cookie);
  const kRow = reloaded.text.split('name="gradeLevel" value="Kindergarten"')[1].split('</tr>')[0];
  assert.match(kRow, /value="5"/);
  assert.match(kRow, /value="2026-09-01"/);
});

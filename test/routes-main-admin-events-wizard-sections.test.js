// Coverage for a real request: "create a new event it shows 1. details,
// 2. tickets 3. permissions. where are the rest of the pages? settings,
// food, volunteers, etc." The Create Event wizard's own Permissions step
// briefly gained an "Event Sections" checkbox trio (Volunteers/Donations/
// Food) so an admin could see and control these sections before ever
// reaching the per-event builder. A later real request ("Don't ask for
// volunteer, food, extra fields or donations during initial event
// creation... Then you can go in and use the full editing features")
// removed that checkbox trio from the wizard again - these tests now
// cover that the wizard page no longer shows it, and that
// registrationFieldsFromBody's own defaults (Volunteers/Donations on,
// Food off) still apply when the wizard submits none of these fields at
// all, same as a raw caller always could.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-wizard-sections-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-wizard-sections-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Create Event wizard no longer asks about Volunteers/Donations/Food/Extra Fields at all', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Event Sections/);
  assert.doesNotMatch(res.text, /name="volunteersEnabled"/);
  assert.doesNotMatch(res.text, /name="donationsEnabled"/);
  assert.doesNotMatch(res.text, /name="foodEnabled"/);
});

test('a direct POST with explicit Event Sections values (e.g. an older client, or a script) still saves exactly what it sends - the route itself still honors them even though the wizard no longer offers them', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      title: 'Custom Sections Event',
      startsAt: '2027-09-01T18:00',
      volunteersEnabled: '0',
      donationsEnabled: '0',
      foodEnabled: '1',
      _csrf: admin.csrfToken,
    });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  const row = await db.prepare('SELECT volunteers_enabled, donations_enabled, food_enabled FROM events WHERE id = ?').get(eventId);
  assert.equal(row.volunteers_enabled, 0);
  assert.equal(row.donations_enabled, 0);
  assert.equal(row.food_enabled, 1);

  // A later real request folded Donations/Food/Extra Fields into the
  // Volunteers tab (renamed "Resources/Fields") as a pill toggle, so
  // Food is no longer its own top-level tab - it's reachable via
  // ?tab=volunteers&section=food.
  const builderPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=food`).set('Cookie', admin.cookie);
  assert.match(builderPage.text, />Food</, 'the Food pill should appear under the Resources/Fields tab');
  assert.match(builderPage.text, /<input type="checkbox" name="enabled" value="1" checked/, 'Food should be enabled per the submitted value');
});

test('creating an event through the real wizard (no Event Sections fields sent) keeps Volunteers/Donations on and Food off by default', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'No Sections Fields Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  const row = await db.prepare('SELECT volunteers_enabled, donations_enabled, food_enabled FROM events WHERE id = ?').get(eventId);
  assert.equal(row.volunteers_enabled, 1);
  assert.equal(row.donations_enabled, 1);
  assert.equal(row.food_enabled, 0);
});

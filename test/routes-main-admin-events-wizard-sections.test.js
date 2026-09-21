// Coverage for a real request: "create a new event it shows 1. details,
// 2. tickets 3. permissions. where are the rest of the pages? settings,
// food, volunteers, etc." The Create Event wizard's own Permissions step
// (views/admin-events-new.ejs) gained an "Event Sections" checkbox trio
// (Volunteers/Donations/Food, each an existing plain event column) so an
// admin can see and control these sections before ever reaching the
// per-event builder that has them as full tabs - see
// routes/admin-events.js's own registrationFieldsFromBody comment for why
// the actual items (food/donation/volunteer entries) still only become
// addable once the event has a real id, right after saving.
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

test('Create Event wizard has an Event Sections checkbox trio (Volunteers/Donations/Food)', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Event Sections/);
  assert.match(res.text, /name="volunteersEnabled" value="1" checked/);
  assert.match(res.text, /name="donationsEnabled" value="1" checked/);
  assert.match(res.text, /name="foodEnabled" value="1"(?! checked)/);
});

test('submitting the wizard untouched (both the hidden fallback and the checked box fire) keeps Volunteers/Donations on and Food off', async () => {
  const admin = await loginAsMainAdmin();
  // Mirrors an untouched real browser submit: the hidden "0" fallback and
  // the checked checkbox share a name, so BOTH values are sent for
  // volunteersEnabled/donationsEnabled - Food has no such pair since it
  // starts unchecked.
  const body =
    `title=${encodeURIComponent('Default Sections Event')}&startsAt=${encodeURIComponent('2027-09-01T18:00')}` +
    `&volunteersEnabled=0&volunteersEnabled=1&donationsEnabled=0&donationsEnabled=1&_csrf=${encodeURIComponent(admin.csrfToken)}`;
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(body);
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  const row = await db.prepare('SELECT volunteers_enabled, donations_enabled, food_enabled FROM events WHERE id = ?').get(eventId);
  assert.equal(row.volunteers_enabled, 1);
  assert.equal(row.donations_enabled, 1);
  assert.equal(row.food_enabled, 0);
});

test('unchecking Volunteers/Donations and checking Food in the wizard saves exactly that', async () => {
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
  assert.equal(row.volunteers_enabled, 0, 'unchecking Volunteers in the wizard should turn it off');
  assert.equal(row.donations_enabled, 0, 'unchecking Donations in the wizard should turn it off');
  assert.equal(row.food_enabled, 1, 'checking Food in the wizard should turn it on');

  const builderPage = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builderPage.text, />Food</, 'the Food tab should now appear on the builder');
});

test('a plain create with no Event Sections fields at all (a raw caller bypassing the wizard form) keeps the old Volunteers/Donations-on-by-default behavior', async () => {
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

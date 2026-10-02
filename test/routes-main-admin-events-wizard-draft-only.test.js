// A real request: "After creating an event you can click create draft
// only, no immediate publishing. Then you can go in and use the full
// editing features." Also folds in a related real request: "Price,
// charged per person, and payment title are not needed. All pricing will
// happen with adding ticket pricing, even if it is only one ticket" -
// applied to the wizard too, since a real Ticket Type needs the event to
// already exist and can only ever be added from the Finance tab after
// creation, so the wizard's own flat-price Tickets step is gone along
// with Publish.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-wizard-draft-only-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-wizard-draft-only-test-uploads-${process.pid}`);
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

test('Create Event wizard: no Publish button anywhere, no Tickets step, only two steps (Details, Permissions)', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);

  assert.doesNotMatch(res.text, />Publish Event</);
  assert.doesNotMatch(res.text, /value="published"/);
  assert.match(res.text, />Create Draft</);

  assert.doesNotMatch(res.text, /<h2>Tickets<\/h2>/);
  assert.doesNotMatch(res.text, /name="priceDollars"/);
  assert.doesNotMatch(res.text, /name="pricePer"/);

  const stepLabels = [...res.text.matchAll(/<span class="event-wizard-step-label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(stepLabels, ['Details', 'Permissions']);
});

test('Create Event wizard: posting a crafted status=published still creates a draft - no way to publish immediately', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Sneaky Publish Attempt', startsAt: '2027-09-01T18:00', status: 'published', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);

  const event = await db.prepare('SELECT status FROM events WHERE id = ?').get(eventId);
  assert.equal(event.status, 'draft', 'creation must always land as draft regardless of a submitted status');
  assert.match(res.headers.location, /notice=Draft%20saved/);
});

test('A newly created draft can still be published afterward from the real builder, same as always', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Publish After Draft Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location)[1]);
  assert.equal((await db.prepare('SELECT status FROM events WHERE id = ?').get(eventId)).status, 'draft');

  await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'published', _csrf: admin.csrfToken });

  assert.equal((await db.prepare('SELECT status FROM events WHERE id = ?').get(eventId)).status, 'published');
});

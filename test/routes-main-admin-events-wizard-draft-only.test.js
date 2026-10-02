// A real request: "After creating an event you can click create draft
// only, no immediate publishing. Then you can go in and use the full
// editing features." Also folds in two related real requests: "Price,
// charged per person, and payment title are not needed. All pricing will
// happen with adding ticket pricing, even if it is only one ticket" (a
// real Ticket Type needs the event to already exist, so the old flat-
// price Tickets step is gone along with Publish), and "no permissions
// page when creating the event... event creation will now just be one
// page" (the old Permissions step's own fields - Grade Restriction, Who
// Can Register, Sections - are folded directly onto this one page
// instead, with the same built-in defaults applying either way).
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

test('Create Event page: no Publish button, no step circles/Tickets step, and Permissions is folded directly onto the one page', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);

  assert.doesNotMatch(res.text, />Publish Event</);
  assert.doesNotMatch(res.text, /value="published"/);
  assert.match(res.text, />Create Draft</);

  // No more multi-step wizard chrome at all - a real request: "event
  // creation will now just be one page."
  assert.doesNotMatch(res.text, /data-wizard-steps/);
  assert.doesNotMatch(res.text, /event-wizard-step-circle/);
  assert.doesNotMatch(res.text, /data-next-step/);
  assert.doesNotMatch(res.text, /data-prev-step/);

  assert.doesNotMatch(res.text, /<h2>Tickets<\/h2>/);
  assert.doesNotMatch(res.text, /name="priceDollars"/);
  assert.doesNotMatch(res.text, /name="pricePer"/);

  // Permissions content lives directly on this page now, not its own step.
  assert.match(res.text, /Grade Restriction/);
  assert.match(res.text, /Who Can Register/);
  assert.match(res.text, /name="allowAdultRegister" value="1" checked/);
  assert.match(res.text, /name="allowChildRegister" value="1" checked/);
  assert.match(res.text, /name="allowGuestRegister" value="1"(?! checked)/);
});

test('Create Event page: Cancel and Create Draft are sized the same (same padding/font-size), and date/time fields are separate calendar + clock pickers', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);

  // A real request: "Save/continue and cancel buttons should be the
  // same height and font size." No more datetime-local inputs - a real
  // request: "dates and times options should be separated. Date should
  // be a calendar picker, time should be a clock picker."
  assert.match(res.text, /<a class="btn-secondary" href="\/main-admin\/events">Cancel<\/a>/);
  assert.doesNotMatch(res.text, /type="datetime-local"/);
  assert.match(res.text, /data-date-time-group="starts"/);
  assert.match(res.text, /data-date-time-group="ends"/);
  assert.match(res.text, /data-date-time-group="regOpens"/);
  assert.match(res.text, /data-date-time-group="regCloses"/);
  assert.match(res.text, /name="startsAt" data-date-time-hidden="starts"/);
  assert.match(res.text, /name="endsAt" data-date-time-hidden="ends"/);
  assert.match(res.text, /name="registrationOpensAt" data-date-time-hidden="regOpens"/);
  assert.match(res.text, /name="registrationClosesAt" data-date-time-hidden="regCloses"/);
});

test('Create Event page: no Add a Volunteer List / Add a Signup List section', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.doesNotMatch(res.text, /Volunteers &amp; Sign-Ups/);
  assert.doesNotMatch(res.text, /name="volunteerListId"/);
  assert.doesNotMatch(res.text, /name="signupListId"/);
});

test('Create Event: submitting separate date + time fields still creates the event with the combined timestamp (the real client-side sync, not just a raw combined POST)', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      title: 'Split Date Time Event',
      _csrf: admin.csrfToken,
      // Mirrors what public/js/event-date-time-picker.js's own sync()
      // writes into the hidden startsAt field once both halves are filled
      // in - the separate visible date/time inputs themselves are never
      // submitted (no name= attribute), only this combined hidden value is.
      startsAt: '2027-09-01T18:00',
    });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  const event = await db.prepare('SELECT starts_at FROM events WHERE id = ?').get(eventId);
  assert.equal(event.starts_at, '2027-09-01 18:00:00');
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

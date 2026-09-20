// Coverage for four real requests on Main Admin Events:
// - "event slug should say event url. It should show the web address
//   then finish with the text box to add the custom ending" (creation)
// - "drop down with title, add a volunteer list. Dropdown with title
//   add a signup list" (creation)
// - "location (legacy text - prefer the dropdown below). Should say
//   location details" (edit)
// - "cancel event button should leave the event on the calendar but the
//   title will be marked through with a line. End of title will say
//   canceled in capital letters. Automatic email will be sent to anyone
//   registered... There should also be a delete event button added."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-url-lists-cancel-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-url-lists-cancel-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .type('form')
    .set('Cookie', admin.cookie)
    .send({ title: 'Fall Picnic', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const match = /\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location);
  return Number(match[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).type('form').set('Cookie', admin.cookie).send({ status: 'published', _csrf: admin.csrfToken });
}

test('New Event wizard: Event URL shows the site origin ahead of the slug input, no more "Event Slug" label', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, />Event Slug</);
  assert.match(page.text, /<label>Event URL/);
  assert.match(page.text, /<span class="event-url-base">https?:\/\/[^<]+\/events\/<\/span>/);
  assert.match(page.text, /name="slug"/);
});

test('New Event wizard: Add a Volunteer List / Add a Signup List dropdowns list only unattached lists, and picking one attaches it on create', async () => {
  const admin = await loginAsMainAdmin();

  const vlRes = await request(app)
    .post('/main-admin/volunteers/volunteer-lists')
    .type('form')
    .set('Cookie', admin.cookie)
    .send({ title: 'Setup Crew List', description: '', _csrf: admin.csrfToken });
  const volunteerListId = Number(/\/volunteer-lists\/(\d+)/.exec(vlRes.headers.location)[1]);

  const slRes = await request(app)
    .post('/main-admin/volunteers/signup-lists')
    .type('form')
    .set('Cookie', admin.cookie)
    .send({ title: 'Potluck Sign-Up', description: '', _csrf: admin.csrfToken });
  const signupListId = Number(/\/signup-lists\/(\d+)/.exec(slRes.headers.location)[1]);

  const page = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.match(page.text, /Add a Volunteer List/);
  assert.match(page.text, new RegExp(`<option value="${volunteerListId}">Setup Crew List</option>`));
  assert.match(page.text, /Add a Signup List/);
  assert.match(page.text, new RegExp(`<option value="${signupListId}">Potluck Sign-Up</option>`));

  const eventId = await createEvent(admin, { volunteerListId: String(volunteerListId), signupListId: String(signupListId) });

  const attachedVl = await db.prepare('SELECT event_id FROM volunteer_signup_lists WHERE id = ?').get(volunteerListId);
  assert.equal(attachedVl.event_id, eventId);
  const attachedSl = await db.prepare('SELECT event_id FROM sign_up_lists WHERE id = ?').get(signupListId);
  assert.equal(attachedSl.event_id, eventId);

  // Already attached to an event now, so it should no longer be offered
  // as "unattached" on a second event's own creation page.
  const secondNewPage = await request(app).get('/main-admin/events/new').set('Cookie', admin.cookie);
  assert.doesNotMatch(secondNewPage.text, /Setup Crew List/);
  assert.doesNotMatch(secondNewPage.text, /Potluck Sign-Up/);
});

test('Event edit: "Location (legacy text...)" label now reads "Location Details"', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const builder = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.doesNotMatch(builder.text, /Location \(legacy text/);
  assert.match(builder.text, /<label>Location Details/);
});

test('Event edit: Delete Event button always shows, not just for drafts', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const builder = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builder.text, /Delete Event/);
});

test('Cancel Event: stays on the calendar with a struck-through title ending in CANCELED, and notifies active registrants', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { startsAt: '2027-10-01T18:00' });
  await publishEvent(admin, eventId);

  // Register a family member so there's someone to notify.
  const member = await db.prepare('SELECT id FROM members LIMIT 1').get();
  const account = await db.prepare('SELECT id FROM member_accounts LIMIT 1').get();
  await db
    .prepare('INSERT INTO event_registrations (event_id, member_id, registered_by_account_id, status) VALUES (?, ?, ?, ?)')
    .run(eventId, member.id, account.id, 'confirmed');

  await request(app).post(`/main-admin/events/${eventId}/status`).type('form').set('Cookie', admin.cookie).send({ status: 'cancelled', _csrf: admin.csrfToken });

  const calendar = await request(app).get('/main-admin/events?tab=calendar&view=list&month=2027-10').set('Cookie', admin.cookie);
  assert.equal(calendar.status, 200);
  assert.match(calendar.text, /class="event-title-cancelled">Fall Picnic CANCELED</);

  const notification = await db.prepare("SELECT * FROM notifications WHERE member_account_id = ? AND type_key = 'event_cancelled'").get(account.id);
  assert.ok(notification, 'the registered account should have received an event_cancelled notification');
  assert.match(notification.title, /Fall Picnic/);
});

// A real request: "when you click register next to a member the page
// will not refresh. The button will turn white and say registered,
// unless there is a popup for tickets [or extra fields]. Then that would
// happen first then it would say registered. Add check boxes next to
// each member to be able to register multiple family members at once
// [and] select the button register selected." (Volunteer/Food/Donation
// sign-ups stay their own separate sections, per a follow-up answer -
// not part of this popup.)
//
// public/js/events-detail-register.js drives the no-reload behavior in a
// real browser (confirmed manually with Playwright: register with no
// navigation, button swaps to a white "Registered" state, cancelling it
// restores the checkbox, the ticket/extra-field dialog opens/submits/
// closes without a reload) - this file covers the HTTP-level contract
// that JS depends on: routes/events.js's /register and /unregister
// responding with JSON (not a redirect) when asked for it, and
// views/events-detail.ejs rendering the checkboxes/bulk button/dialog
// markup exactly where events-detail-register.js expects to find them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-register-ajax-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-register-ajax-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');

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
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Register AJAX Event', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

async function addTicketType(admin, eventId, title, priceDollars) {
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title, priceDollars: String(priceDollars), pricePer: 'person', _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createParentAccount(extraMembers = 0) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Ajax Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Ajax Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const others = [];
  for (let i = 0; i < extraMembers; i++) {
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Ajax Child ${familyCounter}-${i}`, code, code, familyId);
    others.push(info.lastInsertRowid);
  }
  const email = `ajax-parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyMemberIds: others };
}

test('POST /register with Accept: application/json responds with JSON and does not redirect', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const res = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json');
  assert.equal(res.body.ok, true);
  assert.match(res.body.notice, /Register/i);

  const row = await db.prepare("SELECT status FROM event_registrations WHERE event_id = ? AND member_id = ?").get(eventId, parent.memberId);
  assert.equal(row.status, 'confirmed');
});

test('POST /register with Accept: application/json responds with a JSON error (not a redirect) when the member is ineligible', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await db.prepare('UPDATE events SET lock_registration_to_age = 1, age_group_restriction = ? WHERE id = ?').run('8', eventId);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await db.prepare('UPDATE members SET birthday = ? WHERE id = ?').run(`${new Date().getUTCFullYear() - 40}-01-01`, parent.memberId);

  const res = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.error);
});

test('POST /unregister with Accept: application/json responds with JSON and does not redirect', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  const res = await request(app)
    .post(`/events/${eventId}/unregister`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const row = await db.prepare("SELECT status FROM event_registrations WHERE event_id = ? AND member_id = ?").get(eventId, parent.memberId);
  assert.equal(row.status, 'cancelled');
});

test('POST /unregister with Accept: application/json responds with a JSON error when cancellations are disallowed', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await db.prepare('UPDATE events SET allow_registration_cancellations = 0 WHERE id = ?').run(eventId);

  const res = await request(app)
    .post(`/events/${eventId}/unregister`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  assert.equal(res.status, 422);
  assert.equal(res.body.ok, false);
});

test('a plain (non-JS) form POST to /register and /unregister still redirects, unaffected by the JSON path', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const registerRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(registerRes.status, 302);
  assert.match(registerRes.headers.location, new RegExp(`/events/${eventId}`));

  const unregisterRes = await request(app)
    .post(`/events/${eventId}/unregister`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(unregisterRes.status, 302);
  assert.match(unregisterRes.headers.location, new RegExp(`/events/${eventId}`));
});

test('plain event (no tickets/extra fields): checkboxes and a "Register Selected" button appear when more than one member is eligible to register', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /id="event-register-member-list"[^>]*data-needs-dialog="0"/);
  assert.match(page.text, /id="event-register-selected-btn"/);
  assert.match(page.text, /class="event-register-member-checkbox"/g);
  // No dialog markup at all for the plain case.
  assert.doesNotMatch(page.text, /id="event-register-dialog"/);
});

test('an event with only one eligible member shows no "Register Selected" bulk button (nothing to select in bulk)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(0);

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(page.text, /id="event-register-selected-btn"/);
});

test('an event with a ticket type opens a dialog instead of checkboxes - no bulk button, dialog markup present', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addTicketType(admin, eventId, 'General Admission', 10);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /id="event-register-member-list"[^>]*data-needs-dialog="1"/);
  assert.doesNotMatch(page.text, /id="event-register-selected-btn"/);
  assert.doesNotMatch(page.text, /class="event-register-member-checkbox"/);
  assert.match(page.text, /id="event-register-dialog"/);
  assert.match(page.text, /name="ticketTypeId"/);
});

test('plain event: a registered member\'s row says "Unregister" (not "Registered") and keeps its checkbox, marked data-registered="1"', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);

  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(
    page.text,
    /class="event-register-member-row" data-member-id="\d+" data-member-name="[^"]*" data-registered="1">\s*<span class="event-register-member-info">\s*<input type="checkbox" class="event-register-member-checkbox"/,
    'a registered member still gets a checkbox (for bulk unregister) and is flagged data-registered="1"'
  );
  assert.match(page.text, />Unregister</);
  assert.doesNotMatch(page.text, />Registered</, 'the button must say "Unregister", not the old "Registered" label');

  // The still-unregistered family member's own row is unaffected.
  assert.match(page.text, /data-registered="0"/);
});

test('the events-detail-register.js script is included on the page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /<script src="\/js\/events-detail-register\.js"><\/script>/);
});

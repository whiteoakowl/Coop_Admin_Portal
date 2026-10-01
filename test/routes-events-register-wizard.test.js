// Coverage for a real request: "after asking about signups, food, etc.
// you are taken to a ticket view and selection screen. After selecting
// the ticket you want you click submit and you are taken to a payment
// screen. We stop there because there is no processor for payment yet.
// For now it creates an invoice and registration is completed. Message
// that says thank you for registering for the event!"
//
// The old single-screen Register dialog (views/events-detail.ejs) is now
// a sequence of .register-dialog-step panels - details (extra fields/
// volunteer/donation/food), ticket (radio cards, replacing the old plain
// <select>), and payment (a stub "no processor yet" screen) - plus a
// separate #event-register-thankyou-dialog shown after a successful
// AJAX registration. This file covers the server-rendered markup that
// public/js/events-detail-register.js depends on to drive that wizard;
// the actual registerForEvent()/charge behavior underneath is already
// covered by test/routes-events-register-ajax.test.js and
// test/routes-main-admin-events-finance-tickets-accounting.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-register-wizard-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-register-wizard-test-uploads-${process.pid}`);
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
    .send({ title: 'Register Wizard Event', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
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

async function addExtraField(admin, eventId, label) {
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label, fieldType: 'text', required: '1', _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Wizard Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Wizard Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const email = `wizard-parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

test('ticketed event: dialog renders a details step (extra field), a ticket step with radio cards, and a payment step, plus the thank-you dialog', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addExtraField(admin, eventId, 'Shirt Size');
  await addTicketType(admin, eventId, 'General Admission', 10);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);

  // Details step: visible by default, has the extra field, Cancel + Next (not a bare Register).
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.match(page.text, /Shirt Size/);
  assert.match(page.text, /id="event-register-dialog-cancel">Cancel<\/button>/);
  assert.match(page.text, /class="primary-btn js-dialog-next">Next<\/button>/);

  // Ticket step: hidden by default (details comes first), radio cards not a <select>.
  assert.match(page.text, /<div class="register-dialog-step" data-step="ticket" hidden>/);
  assert.match(page.text, /class="member-form-full ticket-select-list"/);
  assert.match(page.text, /<input type="radio" name="ticketTypeId" value="\d+" data-price-label="General Admission[^"]*"/);
  assert.doesNotMatch(page.text, /<select name="ticketTypeId"/);

  // Payment step: hidden, always last, stub copy, "Complete Registration" submit.
  assert.match(page.text, /<div class="register-dialog-step" data-step="payment" hidden>/);
  assert.match(page.text, /Online payment isn't set up yet/);
  assert.match(page.text, /<button type="submit" class="primary-btn">Complete Registration<\/button>/);

  // The thank-you dialog exists with the event's title and an invoice mention.
  assert.match(page.text, /<dialog id="event-register-thankyou-dialog"/);
  assert.match(page.text, /Thank you for registering for <strong>Register Wizard Event<\/strong>!/);
  assert.match(page.text, /An invoice has been created for your registration/);
});

test('free event with only an extra field: no ticket/payment step, dialog submits straight to a plain "Register" button', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addExtraField(admin, eventId, 'Dietary Restrictions');
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.doesNotMatch(page.text, /data-step="ticket"/);
  assert.doesNotMatch(page.text, /data-step="payment"/);
  assert.match(page.text, /<button type="submit" class="primary-btn">Register<\/button>/);
  assert.doesNotMatch(page.text, /Complete Registration/);
  // Thank-you dialog still renders (any successful dialog registration gets one).
  assert.match(page.text, /<dialog id="event-register-thankyou-dialog"/);
  assert.doesNotMatch(page.text, /An invoice has been created/);
});

test('flat-priced event (no distinct ticket types) with an extra field: details step then straight to payment, skipping the ticket step', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { priceDollars: '25', pricePer: 'person' });
  await addExtraField(admin, eventId, 'Allergies');
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.doesNotMatch(page.text, /data-step="ticket"/);
  assert.match(page.text, /<div class="register-dialog-step" data-step="payment" hidden>/);
  // Flat price has no radios to compute from, so the summary is rendered statically.
  assert.match(page.text, /<p class="member-form-full" id="event-register-payment-summary">\s*\$25\.00 \/ person/);
  assert.match(page.text, /<button type="submit" class="primary-btn">Complete Registration<\/button>/);
});

test('registering through the wizard\'s final step still actually confirms the registration (AJAX JSON path)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const ticketRes = await addTicketType(admin, eventId, 'General Admission', 10);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  const ticketType = await db.prepare('SELECT id FROM event_ticket_types WHERE event_id = ?').get(eventId);

  const res = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), ticketTypeId: String(ticketType.id), _csrf: parent.csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  assert.equal(registration.status, 'confirmed');
  assert.ok(registration.charge_id, 'a charge ("invoice") should have been created for the priced ticket');
});

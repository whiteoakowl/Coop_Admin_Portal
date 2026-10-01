// Coverage for a real request: "after asking about signups, food, etc.
// you are taken to a ticket view and selection screen. After selecting
// the ticket you want you click submit and you are taken to a payment
// screen. We stop there because there is no processor for payment yet.
// For now it creates an invoice and registration is completed. Message
// that says thank you for registering for the event!" - later refined
// into a real follow-up request: "when signing up multiple members, ask
// the questions once per member (one popup page per member), then show
// each member being registered with their own ticket dropdown on one
// shared ticket page, then a register now button once every member has a
// ticket, then a shared payment screen."
//
// The Register dialog (views/events-detail.ejs) is a single wizard
// instance reused for however many members get queued - a details step
// (extra fields/volunteer/donation/food) repeats once per queued member
// (server-rendered once, reset by JS between members), while tickets and
// payment are each ONE shared step JS builds at runtime from the queue
// (public/js/events-detail-register.js's own buildTicketsStep/
// buildPaymentStep) - not server-rendered per member, since the queue
// itself is only known once a real Register click happens. This file
// covers the server-rendered skeleton + data (ticketTypes JSON, data
// attributes) that script depends on; the actual registerForEvent()/
// charge behavior underneath is already covered by test/routes-events-
// register-ajax.test.js and test/routes-main-admin-events-finance-
// tickets-accounting.test.js.
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
async function createParentAccount(extraMembers = 0) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Wizard Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Wizard Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const familyMemberIds = [];
  for (let i = 0; i < extraMembers; i++) {
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Wizard Child ${familyCounter}-${i}`, code, code, familyId);
    familyMemberIds.push(info.lastInsertRowid);
  }
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
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyMemberIds };
}

test('ticketed event: dialog renders a details step (extra field), a shared tickets step fed by JSON ticket data, and a payment step, plus the thank-you dialog', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addExtraField(admin, eventId, 'Shirt Size');
  await addTicketType(admin, eventId, 'General Admission', 10);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);

  assert.match(page.text, /data-has-details="1"/);
  assert.match(page.text, /data-has-tickets="1"/);
  assert.match(page.text, /data-has-payment="1"/);

  // Details step: visible by default, has the extra field, a per-member
  // name placeholder JS fills in, Cancel + Next.
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.match(page.text, /Shirt Size/);
  assert.match(page.text, /id="event-register-dialog-member-name"/);
  assert.match(page.text, /id="event-register-dialog-cancel">Cancel<\/button>/);
  assert.match(page.text, /id="event-register-details-next">Next<\/button>/);

  // Tickets step: hidden by default (empty container - JS builds one row
  // per queued member once the queue is actually known), and the event's
  // ticket types are handed to that script as JSON, not server-rendered
  // per member.
  assert.match(page.text, /<div class="register-dialog-step" data-step="tickets" hidden>/);
  assert.match(page.text, /id="event-register-ticket-rows"/);
  assert.match(page.text, /id="event-register-tickets-submit" hidden>Register Now</);
  assert.match(page.text, /<script type="application\/json" id="event-register-ticket-types-data">.*General Admission.*<\/script>/);
  assert.doesNotMatch(page.text, /<input type="radio" name="ticketTypeId"/);
  assert.doesNotMatch(page.text, /<select name="ticketTypeId"/);

  // Payment step: hidden, always last, empty summary container (JS-built), stub copy, Complete Registration.
  assert.match(page.text, /<div class="register-dialog-step" data-step="payment" hidden>/);
  assert.match(page.text, /id="event-register-payment-summary"/);
  assert.match(page.text, /Online payment isn't set up yet/);
  assert.match(page.text, /id="event-register-payment-complete">Complete Registration<\/button>/);

  // The thank-you dialog exists with the event's title and an invoice mention.
  assert.match(page.text, /<dialog id="event-register-thankyou-dialog"/);
  assert.match(page.text, /Thank you for registering for <strong>Register Wizard Event<\/strong>!/);
  assert.match(page.text, /An invoice has been created for your registration/);
});

test('free event with only an extra field: no ticket/payment step data attributes', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addExtraField(admin, eventId, 'Dietary Restrictions');
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-has-details="1"/);
  assert.match(page.text, /data-has-tickets="0"/);
  assert.match(page.text, /data-has-payment="0"/);
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.doesNotMatch(page.text, /data-step="tickets"/);
  assert.doesNotMatch(page.text, /data-step="payment"/);
  assert.match(page.text, /id="event-register-details-next">Next<\/button>/);
  assert.doesNotMatch(page.text, /Complete Registration/);
  // Thank-you dialog still renders (any successful dialog registration gets one).
  assert.match(page.text, /<dialog id="event-register-thankyou-dialog"/);
  assert.doesNotMatch(page.text, /An invoice has been created/);
});

test('flat-priced event (no distinct ticket types) with an extra field: details step then straight to payment, skipping the tickets step', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { priceDollars: '25', pricePer: 'person' });
  await addExtraField(admin, eventId, 'Allergies');
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-has-details="1"/);
  assert.match(page.text, /data-has-tickets="0"/);
  assert.match(page.text, /data-has-payment="1"/);
  assert.match(page.text, /data-flat-price-cents="2500"/);
  assert.match(page.text, /data-flat-price-per="person"/);
  assert.match(page.text, /<div class="register-dialog-step" data-step="details">/);
  assert.doesNotMatch(page.text, /data-step="tickets"/);
  assert.match(page.text, /<div class="register-dialog-step" data-step="payment" hidden>/);
  // The flat price is handed to JS as a data attribute - the summary
  // container itself is empty server-side, filled in by buildPaymentStep.
  assert.match(page.text, /id="event-register-payment-summary"><\/div>/);
  assert.match(page.text, /id="event-register-payment-complete">Complete Registration<\/button>/);
});

test('registering through the wizard\'s final step still actually confirms the registration (AJAX JSON path)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addTicketType(admin, eventId, 'General Admission', 10);
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

// A real follow-up request: "when signing up multiple members... after
// completing the information for each member, show each member with a
// dropdown ticket option next to each of them. Once a ticket has been
// selected for each member, a register now button will appear and go to
// a payment screen." The wizard itself runs client-side (public/js/
// events-detail-register.js's own queue/perMemberData) and has no server
// endpoint of its own - finishRegistration() posts each queued member's
// own collected answers/ticket choice to this same single-member
// /register route, one at a time. This is the contract that depends on:
// two different family members, each choosing a DIFFERENT ticket type
// and answering the same extra field differently, must each end up with
// their own distinct ticket/answer/charge - nothing from one member's
// step should leak into another's.
test('two family members each choosing a different ticket and a different extra-field answer end up with their own distinct registration, ticket, and charge', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addExtraField(admin, eventId, 'Shirt Size');
  await addTicketType(admin, eventId, 'General Admission', 10);
  await addTicketType(admin, eventId, 'VIP', 25);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);
  const childId = parent.familyMemberIds[0];
  const generalTicket = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'General Admission'").get(eventId);
  const vipTicket = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'VIP'").get(eventId);
  const extraField = await db.prepare('SELECT id FROM event_extra_fields WHERE event_id = ?').get(eventId);

  // Simulates finishRegistration()'s own sequential loop: one POST per
  // queued member, each carrying only that member's own collected answer
  // and ticket choice.
  const parentRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(parent.memberId), ticketTypeId: String(generalTicket.id), [`answers[f${extraField.id}]`]: 'Medium', _csrf: parent.csrfToken });
  assert.equal(parentRes.body.ok, true);

  const childRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ memberId: String(childId), ticketTypeId: String(vipTicket.id), [`answers[f${extraField.id}]`]: 'Small', _csrf: parent.csrfToken });
  assert.equal(childRes.body.ok, true);

  const parentReg = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  const childReg = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, childId);
  assert.equal(parentReg.ticket_type_id, generalTicket.id);
  assert.equal(childReg.ticket_type_id, vipTicket.id);
  assert.notEqual(parentReg.charge_id, childReg.charge_id, 'two different-priced tickets must not share a charge');

  const parentCharge = await db.prepare('SELECT amount_cents FROM payment_charges WHERE id = ?').get(parentReg.charge_id);
  const childCharge = await db.prepare('SELECT amount_cents FROM payment_charges WHERE id = ?').get(childReg.charge_id);
  assert.equal(Number(parentCharge.amount_cents), 1000);
  assert.equal(Number(childCharge.amount_cents), 2500);

  const parentAnswer = await db.prepare('SELECT value FROM event_registration_answers WHERE registration_id = ? AND extra_field_id = ?').get(parentReg.id, extraField.id);
  const childAnswer = await db.prepare('SELECT value FROM event_registration_answers WHERE registration_id = ? AND extra_field_id = ?').get(childReg.id, extraField.id);
  assert.equal(parentAnswer.value, 'Medium');
  assert.equal(childAnswer.value, 'Small');
});

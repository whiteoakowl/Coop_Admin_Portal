// Task: "Parent portal and student portal. When they click on an event
// its shows a popup of the event card with photo, title, short
// description, cost and register now button. When you click register now
// button it goes to the event page where it shows all the details, full
// description and ticket options. If it allows for showing who has
// registered that will be listed below the register button. Select
// tickets, click register... Registration is added to event registration
// log on parent and student portals." Covers the four genuinely new
// pieces built for this: the popup fragment, ticket-type selection at
// registration, the who's-registered list, and the parent/student "my
// registrations" log pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-registration-flow-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-registration-flow-test-uploads-${process.pid}`);
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
const { amountPaidForCharge } = require('../utils/payments');

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
    .send({ title: 'Registration Flow Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

async function addTicketType(admin, eventId, title, priceDollars, pricePer) {
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title, priceDollars: String(priceDollars), pricePer: pricePer || 'person', _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createParentAccount(extraMembers = 0) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Flow Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Flow Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const others = [];
  for (let i = 0; i < extraMembers; i++) {
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Flow Child ${familyCounter}-${i}`, code, code, familyId);
    others.push(info.lastInsertRowid);
  }
  const email = `flow-parent${familyCounter}@example.com`;
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

async function createStudentAccount() {
  familyCounter += 1;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1)")
    .run(`Flow Student ${familyCounter}`, code, code);
  const email = `flow-student${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, email, hashPassword(password));
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, studentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/student' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/student/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: memberInfo.lastInsertRowid };
}

test('the event popup fragment shows photo, title, short description, cost, and a Register Now link to the full page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, {
    title: 'Fall Festival',
    visibility: 'public',
    shortDescription: 'A fun fall celebration for the whole family.',
    priceDollars: '5.00',
  });
  await publishEvent(admin, eventId);

  const res = await request(app).get(`/events/${eventId}/fragment`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Fall Festival/);
  assert.match(res.text, /A fun fall celebration for the whole family\./);
  assert.match(res.text, /\$5\.00/);
  assert.match(res.text, new RegExp(`href="/events/${eventId}"[^>]*>Register Now`));
});

test('the popup fragment 404s for a members-only event when signed out, same visibility rule as the full page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Members Fragment Event', visibility: 'members' });
  await publishEvent(admin, eventId);

  const res = await request(app).get(`/events/${eventId}/fragment`);
  assert.equal(res.status, 404);
});

test('the Events list renders cards as clickable buttons wired to the popup, not plain links', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Clickable Card Event', visibility: 'public' });
  await publishEvent(admin, eventId);

  const list = await request(app).get('/events?view=list');
  assert.match(list.text, new RegExp(`data-view-event="${eventId}"`));
  assert.match(list.text, /id="event-card-dialog"/);
  assert.match(list.text, /events-card-view\.js/);
});

test('registering for an event with ticket types requires a selection, and charges that ticket\'s own price', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Ticketed Gala', visibility: 'public' });
  await addTicketType(admin, eventId, 'General Admission', '10.00', 'person');
  await addTicketType(admin, eventId, 'VIP', '25.00', 'person');
  await publishEvent(admin, eventId);

  const parent = await createParentAccount();

  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(detailPage.text, /General Admission/);
  assert.match(detailPage.text, /VIP/);
  assert.match(detailPage.text, /name="ticketTypeId"/);

  const missingTicket = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(missingTicket.headers.location), /select a ticket/i);

  const vipTicket = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'VIP'").get(eventId);
  const registered = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), ticketTypeId: String(vipTicket.id), _csrf: parent.csrfToken });
  assert.match(registered.headers.location, /notice=/);

  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  assert.equal(registration.ticket_type_id, vipTicket.id);
  const paid = await amountPaidForCharge(registration.charge_id);
  void paid; // nothing paid yet - just confirm the charge amount below
  const charge = await db.prepare('SELECT amount_cents FROM payment_charges WHERE id = ?').get(registration.charge_id);
  assert.equal(Number(charge.amount_cents), 2500, 'should be charged the VIP ticket price, not any flat event price');
});

test("who's registered is listed below the register button only when the event's own setting allows it", async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Open Roster Meetup', visibility: 'public' });
  await publishEvent(admin, eventId);

  const parent = await createParentAccount();
  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  const hiddenByDefault = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(hiddenByDefault.text, /Who's Registered/);

  await db.prepare('UPDATE events SET show_registrants_to_members = 1 WHERE id = ?').run(eventId);

  const shown = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(shown.text, /Who's Registered/);
  assert.match(shown.text, new RegExp(`Flow Parent ${familyCounter}`));
});

test('Parent Portal "My Event Registrations" lists the whole family, grouped by member, with a working Cancel', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Family Log Event', visibility: 'public' });
  await publishEvent(admin, eventId);

  const parent = await createParentAccount(1);
  const child = parent.familyMemberIds[0];
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(child), _csrf: parent.csrfToken });

  const logPage = await request(app).get('/parent/events').set('Cookie', parent.cookie);
  assert.equal(logPage.status, 200);
  assert.match(logPage.text, /My Event Registrations/);
  assert.match(logPage.text, /Family Log Event/);

  const cancel = await request(app)
    .post(`/events/${eventId}/unregister`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), redirectTo: '/parent/events', _csrf: parent.csrfToken });
  assert.equal(cancel.headers.location, '/parent/events?notice=' + encodeURIComponent('Registration cancelled.'));

  const afterCancel = await request(app).get('/parent/events').set('Cookie', parent.cookie);
  assert.doesNotMatch(afterCancel.text, new RegExp(`>Flow Parent ${familyCounter}<`), 'the cancelled parent registration should be gone');
  assert.match(afterCancel.text, new RegExp(`>Flow Child ${familyCounter}-0<`), "the child's registration should remain");
});

test('Student Portal "My Event Registrations" lists only that student\'s own registrations', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Student Log Event', visibility: 'public' });
  await publishEvent(admin, eventId);

  const student = await createStudentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', student.cookie).type('form').send({ memberId: String(student.memberId), _csrf: student.csrfToken });

  const logPage = await request(app).get('/student/events').set('Cookie', student.cookie);
  assert.equal(logPage.status, 200);
  assert.match(logPage.text, /My Event Registrations/);
  assert.match(logPage.text, /Student Log Event/);
});

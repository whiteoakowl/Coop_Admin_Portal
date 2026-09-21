// A real request: "event settings, finance, if charging per person there
// should be an option for adding several types of tickets with a
// different price and title bar next to it. Add a drop down menu for
// choosing accounting category." Admin-side only for now (a scoping
// question confirmed this) - registration doesn't yet let a registrant
// pick one and be charged accordingly. A later real request: "add ticket
// types, price, title and permissions person or family... accounting
// category drop is all that is now needed above ticket types" - each
// ticket type now carries its own person/family basis, and the Finance
// tab's own flat Price/Charged Per fields are gone (Accounting Category
// is the only thing left above the Ticket Types list).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-finance-tickets-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-finance-tickets-test-uploads-${process.pid}`);
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
    .send({ title: 'Finance Tab Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

test('Finance tab: only an Accounting Category dropdown, no flat Price/Charged Per fields', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  // Isolate the actual Finance form (not the separate Add Ticket Type
  // dialog further down the page, which has its own priceDollars/
  // pricePer fields for the ticket type being added).
  const financeFormMatch = /<form method="POST" action="\/main-admin\/events\/\d+\/finance"[^>]*>([\s\S]*?)<\/form>/.exec(financePage.text);
  assert.ok(financeFormMatch, 'the Finance form should exist');
  assert.match(financeFormMatch[1], /Accounting Category/);
  assert.doesNotMatch(financeFormMatch[1], /name="priceDollars"/, 'the top-of-Finance flat Price field should be gone');
  assert.doesNotMatch(financeFormMatch[1], /name="pricePer"/, 'the top-of-Finance Charged Per dropdown should be gone');
});

test('Accounting Categories: manage from the Events Settings tab, pick one on the Finance tab, and it persists', async () => {
  const admin = await loginAsMainAdmin();

  const settingsPage = await request(app).get('/main-admin/events?tab=settings').set('Cookie', admin.cookie);
  assert.match(settingsPage.text, /Add\/Edit Accounting Category/);
  assert.match(settingsPage.text, /id="manage-accounting-categories-dialog"/);

  const csrf = extractCsrf(settingsPage.text);
  await request(app)
    .post('/main-admin/events/accounting-categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Fundraising Revenue', _csrf: csrf });
  const category = await db.prepare("SELECT id FROM event_accounting_categories WHERE name = 'Fundraising Revenue'").get();
  assert.ok(category, 'the accounting category should be recorded');

  const eventId = await createEvent(admin);
  const financeCsrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie)).text);
  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(financePage.text, /Accounting Category/);
  assert.match(financePage.text, new RegExp(`<option value="${category.id}"[^>]*>Fundraising Revenue</option>`));

  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ accountingCategoryId: String(category.id), _csrf: financeCsrf });

  const event = await db.prepare('SELECT accounting_category_id FROM events WHERE id = ?').get(eventId);
  assert.equal(event.accounting_category_id, category.id);

  const afterPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(afterPage.text, new RegExp(`<option value="${category.id}" selected>Fundraising Revenue</option>`));
});

test('Ticket Types: always offered on the Finance tab (not gated on any flat Charged Per)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(financePage.text, /Ticket Types/);
  assert.match(financePage.text, /\+ Add Ticket Type/);
});

test('Ticket Types: add and delete, with a title, price, and its own person/family basis', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  let page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  let csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Family Pass', priceDollars: '25.00', pricePer: 'family', _csrf: csrf });

  page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(page.text, /Family Pass/);
  assert.match(page.text, /\$25\.00 per family/);

  const ticket = await db.prepare("SELECT * FROM event_ticket_types WHERE event_id = ? AND title = 'Family Pass'").get(eventId);
  assert.ok(ticket);
  assert.equal(ticket.price_per, 'family');
  assert.equal(ticket.price_cents, 2500);

  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types/${ticket.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });

  const afterDelete = await db.prepare('SELECT * FROM event_ticket_types WHERE id = ?').get(ticket.id);
  assert.equal(afterDelete, undefined);

  page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(page.text, /No ticket types yet/);
});

test('Ticket Types: a ticket with no pricePer submitted defaults to person', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Adult', priceDollars: '10.00', _csrf: csrf });

  const ticket = await db.prepare("SELECT * FROM event_ticket_types WHERE event_id = ? AND title = 'Adult'").get(eventId);
  assert.equal(ticket.price_per, 'person');
});

let paymentInstructionsFamilyCounter = 0;
async function createParentAccountForPaymentInstructions() {
  paymentInstructionsFamilyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Payment Instructions Test Family ${paymentInstructionsFamilyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${paymentInstructionsFamilyCounter}`, parentCode, parentCode, familyId);
  const email = `paymentinstructionsparent${paymentInstructionsFamilyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  return { cookie: loginRes.headers['set-cookie'] };
}

test('Payment Instructions: Finance tab has a title+text field, saves, and shows on the public event page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(financePage.text, /name="paymentInstructionsTitle"/);
  assert.match(financePage.text, /name="paymentInstructionsText"/);

  const csrf = extractCsrf(financePage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ paymentInstructionsTitle: 'How to Pay', paymentInstructionsText: 'Pay by cash, check, or Venmo @coopname at drop-off.', _csrf: csrf });

  const event = await db.prepare('SELECT payment_instructions_title, payment_instructions_text FROM events WHERE id = ?').get(eventId);
  assert.equal(event.payment_instructions_title, 'How to Pay');
  assert.equal(event.payment_instructions_text, 'Pay by cash, check, or Venmo @coopname at drop-off.');

  const afterSavePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(afterSavePage.text, /value="How to Pay"/);
  assert.match(afterSavePage.text, /Pay by cash, check, or Venmo @coopname at drop-off\./);

  await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'published', _csrf: admin.csrfToken });

  const parent = await createParentAccountForPaymentInstructions();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.text, /How to Pay/);
  assert.match(detailPage.text, /Pay by cash, check, or Venmo @coopname at drop-off\./);
});

test('Payment Instructions: blank on the Finance tab shows nothing on the public event page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'published', _csrf: admin.csrfToken });

  const parent = await createParentAccountForPaymentInstructions();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
  assert.doesNotMatch(detailPage.text, /alert-info/);
});

// A real request: "event settings, finance, if charging per person there
// should be an option for adding several types of tickets with a
// different price and title bar next to it. Add a drop down menu for
// choosing accounting category." A later real request: "add ticket
// types, price, title and permissions person or family... accounting
// category drop is all that is now needed above ticket types" dropped
// the Finance tab's own flat Price/Charged Per fields - a bug report
// that they'd gone missing briefly restored them (utils/events.js's own
// chargeForConfirmedRegistration does still fall back to event.
// price_cents/price_per whenever a registrant doesn't pick a specific
// Ticket Type), but a further real request made the original removal
// final and deliberate: "Price, charged per person, and payment title
// are not needed. All pricing will happen with adding ticket pricing,
// even if it is only one ticket." Accounting Category plus Ticket Types
// is the whole Finance tab now.
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

test('Finance tab: only Accounting Category above Ticket Types - no flat Price/Charged Per fields, no Payment Instructions Title', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  // Isolate the actual Finance form (not the separate Add Ticket Type
  // dialog further down the page, which has its own priceDollars/
  // pricePer fields for the ticket type being added).
  const financeFormMatch = /<form method="POST" action="\/main-admin\/events\/\d+\/finance"[^>]*>([\s\S]*?)<\/form>/.exec(financePage.text);
  assert.ok(financeFormMatch, 'the Finance form should exist');
  assert.match(financeFormMatch[1], /Accounting Category/);
  assert.doesNotMatch(financeFormMatch[1], /name="priceDollars"/, 'the flat Price field should be gone');
  assert.doesNotMatch(financeFormMatch[1], /name="pricePer"/, 'the flat Charged Per dropdown should be gone');
  assert.doesNotMatch(financeFormMatch[1], /name="paymentInstructionsTitle"/, 'the Payment Instructions Title field should be gone');
  assert.match(financeFormMatch[1], /name="paymentInstructionsText"/, 'Payment Instructions (the free-text field) stays');
});

// A real bug report earlier caught that removing these fields' UI was
// silently charging registrants a price nobody could see or change -
// the fix back then was to preserve (not reset) whatever value was
// already in the column whenever a form stops submitting a field, the
// same "retired but not dropped" treatment as any other column. Confirms
// that guarantee still holds now that the fields are gone for good: an
// event that already has a flat price set (e.g. from old data, or the
// still-unchanged creation wizard) keeps it across an unrelated Finance
// save instead of getting silently wiped to null.
test('Finance tab save never touches an existing flat price - it has no form field to read one from any more', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await db.prepare('UPDATE events SET price_cents = ?, price_per = ? WHERE id = ?').run(1200, 'family', eventId);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ paymentInstructionsText: 'Pay at the door.', _csrf: csrf });

  const event = await db.prepare('SELECT price_cents, price_per, payment_instructions_text FROM events WHERE id = ?').get(eventId);
  assert.equal(event.price_cents, 1200, 'an untouched column must survive a save of the fields that still exist');
  assert.equal(event.price_per, 'family');
  assert.equal(event.payment_instructions_text, 'Pay at the door.');
});

test('Accounting Categories: manage from the Accounting tab (not Events Settings), pick one on the Finance tab, and it persists', async () => {
  const admin = await loginAsMainAdmin();

  // A real request: "add/edit account category button should not be
  // there [on Events Settings]. That should only be under the accounting
  // tab."
  const settingsPage = await request(app).get('/main-admin/events?tab=settings').set('Cookie', admin.cookie);
  assert.doesNotMatch(settingsPage.text, /Add\/Edit Accounting Category/);
  assert.doesNotMatch(settingsPage.text, /id="manage-accounting-categories-dialog"/);

  // A later real request moved this off a modal dialog on the Accounts
  // list and onto its own Accounting > Categories subpage.
  const categoriesPage = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.match(categoriesPage.text, /Category\/Fiscal Year/);
  assert.doesNotMatch(categoriesPage.text, /id="manage-accounting-categories-dialog"/);

  const csrf = extractCsrf(categoriesPage.text);
  await request(app)
    .post('/main-admin/accounting/accounting-categories')
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
  // A real request: "all information should fit on one row in mobile" -
  // the row's own label uses the terser "$25.00/family" instead of
  // "$25.00 per family" to help it stay on one line.
  assert.match(page.text, /\$25\.00\/family/);

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

// A real request: "add a ticket type the chart below that shows
// tickets... click on the ticket to edit and save, close or delete.
// Remove trashcan from ticket list. You can only delete in the edit
// popup window."
test('Ticket Types: the row has no trash icon any more - edit, save, and delete all happen through the ticket\'s own edit dialog', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  let csrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Adult', priceDollars: '10.00', _csrf: csrf });
  const ticket = await db.prepare("SELECT * FROM event_ticket_types WHERE event_id = ? AND title = 'Adult'").get(eventId);

  let page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  // The row itself is a plain button that opens the edit dialog - no
  // per-row delete form/trash icon any more.
  assert.match(page.text, new RegExp(`class="training-lesson-row ticket-type-row"\\s*onclick="document.getElementById\\('edit-ticket-type-dialog-${ticket.id}'\\).showModal\\(\\)"`));
  assert.doesNotMatch(page.text, new RegExp(`ticket-types/${ticket.id}/delete" class="inline-block-form"`));
  // The edit dialog itself exists, pre-filled, with Save/Close/Delete.
  assert.match(page.text, new RegExp(`<dialog id="edit-ticket-type-dialog-${ticket.id}"`));
  assert.match(page.text, /<input type="text" name="title" value="Adult"/);
  assert.match(page.text, />Delete Ticket Type</);
  assert.match(page.text, />Close</);
  assert.match(page.text, />Save</);

  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types/${ticket.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Adult (Updated)', priceDollars: '12.50', pricePer: 'family', includesPhysicalTicket: '1', _csrf: csrf });

  const updated = await db.prepare('SELECT * FROM event_ticket_types WHERE id = ?').get(ticket.id);
  assert.equal(updated.title, 'Adult (Updated)');
  assert.equal(updated.price_cents, 1250);
  assert.equal(updated.price_per, 'family');
  assert.equal(Number(updated.includes_physical_ticket), 1);

  page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(page.text, /\$12\.50\/family/);

  // The ticket-level delete route is still reachable - just from the
  // dialog's own Delete Ticket Type button, not a row-level trash icon.
  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types/${ticket.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  const afterDelete = await db.prepare('SELECT * FROM event_ticket_types WHERE id = ?').get(ticket.id);
  assert.equal(afterDelete, undefined);
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

// A real request: "finance, add ticket type pop up, add a checkbox for
// include physical ticket. Members will be able to print tickets with a
// barcode for check in and out. Barcode is the same as their member ID
// number barcode used for classes."
test('Ticket Types: Add Ticket Type dialog has an Include physical ticket checkbox, and it persists', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(financePage.text, /name="includesPhysicalTicket" value="1"/);
  assert.match(financePage.text, />\s*Include physical ticket\s*</);

  const csrf = extractCsrf(financePage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'General Admission', priceDollars: '5.00', pricePer: 'person', includesPhysicalTicket: '1', _csrf: csrf });

  const ticket = await db.prepare("SELECT * FROM event_ticket_types WHERE event_id = ? AND title = 'General Admission'").get(eventId);
  assert.equal(ticket.includes_physical_ticket, true);

  const afterAdd = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(afterAdd.text, /General Admission[\s\S]*?Physical ticket/);
});

test('Ticket Types: leaving Include physical ticket unchecked defaults to no physical ticket', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'RSVP Only', priceDollars: '0.00', _csrf: csrf });

  const ticket = await db.prepare("SELECT * FROM event_ticket_types WHERE event_id = ? AND title = 'RSVP Only'").get(eventId);
  assert.equal(ticket.includes_physical_ticket, false);
});

let ticketPrintFamilyCounter = 0;
async function createParentWithChildForTicketPrint() {
  ticketPrintFamilyCounter += 1;
  const n = ticketPrintFamilyCounter;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Ticket Print Family ${n}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Ticket Print Parent ${n}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Ticket Print Child ${n}`, childCode, childCode, familyId);
  const email = `ticket-print-parent-${n}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'], childId: Number(childInfo.lastInsertRowid), childBarcode: childCode };
}

test('Print Ticket: shown and printable for a confirmed registration under a physical-ticket ticket type', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(financePage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'General Admission', priceDollars: '0.00', includesPhysicalTicket: '1', _csrf: csrf });
  const ticketType = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'General Admission'").get(eventId);

  const parent = await createParentWithChildForTicketPrint();
  const eventPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  const eventCsrf = extractCsrf(eventPage.text);
  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: parent.childId, ticketTypeId: ticketType.id, _csrf: eventCsrf });

  const myEventsPage = await request(app).get('/parent/events').set('Cookie', parent.cookie);
  assert.match(myEventsPage.text, new RegExp(`href="/events/${eventId}/ticket\\?memberId=${parent.childId}"[^>]*>Print Ticket<`));

  const ticketPage = await request(app).get(`/events/${eventId}/ticket?memberId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(ticketPage.status, 200);
  assert.match(ticketPage.text, new RegExp(`data-barcode-value="${parent.childBarcode}"`));
});

test('Print Ticket: no button and 404 when the registration\'s ticket type has no physical ticket', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const parent = await createParentWithChildForTicketPrint();
  const eventPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  const eventCsrf = extractCsrf(eventPage.text);
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: parent.childId, _csrf: eventCsrf });

  const myEventsPage = await request(app).get('/parent/events').set('Cookie', parent.cookie);
  assert.doesNotMatch(myEventsPage.text, /Print Ticket/);

  const ticketPage = await request(app).get(`/events/${eventId}/ticket?memberId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(ticketPage.status, 404);
});

test('Print Ticket: a signed-in account can never print a ticket for a member outside its own family', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(financePage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'General Admission', priceDollars: '0.00', includesPhysicalTicket: '1', _csrf: csrf });
  const ticketType = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'General Admission'").get(eventId);

  const owner = await createParentWithChildForTicketPrint();
  const eventPage = await request(app).get(`/events/${eventId}`).set('Cookie', owner.cookie);
  const eventCsrf = extractCsrf(eventPage.text);
  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', owner.cookie)
    .type('form')
    .send({ memberId: owner.childId, ticketTypeId: ticketType.id, _csrf: eventCsrf });

  const intruder = await createParentWithChildForTicketPrint();
  const ticketPage = await request(app).get(`/events/${eventId}/ticket?memberId=${owner.childId}`).set('Cookie', intruder.cookie);
  assert.equal(ticketPage.status, 404);
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

// A real request: "Price, charged per person, and payment title are not
// needed" dropped the Title half of this field - the free-text field
// alone still saves and shows on the public page (events-detail.ejs
// conditions on title/text independently, so dropping one doesn't break
// the other).
test('Payment Instructions: Finance tab has a text field (no Title), saves, and shows on the public event page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.doesNotMatch(financePage.text, /name="paymentInstructionsTitle"/);
  assert.match(financePage.text, /name="paymentInstructionsText"/);

  const csrf = extractCsrf(financePage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ paymentInstructionsText: 'Pay by cash, check, or Venmo @coopname at drop-off.', _csrf: csrf });

  const event = await db.prepare('SELECT payment_instructions_text FROM events WHERE id = ?').get(eventId);
  assert.equal(event.payment_instructions_text, 'Pay by cash, check, or Venmo @coopname at drop-off.');

  const afterSavePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(afterSavePage.text, /Pay by cash, check, or Venmo @coopname at drop-off\./);

  await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'published', _csrf: admin.csrfToken });

  const parent = await createParentAccountForPaymentInstructions();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
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

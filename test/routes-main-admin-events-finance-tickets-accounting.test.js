// A real request: "event settings, finance, if charging per person there
// should be an option for adding several types of tickets with a
// different price and title bar next to it. Add a drop down menu for
// choosing accounting category." Admin-side only for now (a scoping
// question confirmed this) - registration still charges the event's own
// flat price_cents; a real ticket-type CHOICE at registration is a
// separate follow-up.
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
    .send({ priceDollars: '10.00', pricePer: 'person', accountingCategoryId: String(category.id), _csrf: financeCsrf });

  const event = await db.prepare('SELECT accounting_category_id FROM events WHERE id = ?').get(eventId);
  assert.equal(event.accounting_category_id, category.id);

  const afterPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(afterPage.text, new RegExp(`<option value="${category.id}" selected>Fundraising Revenue</option>`));
});

test('Ticket Types: only offered when charged per person, not per family', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);

  const perPersonPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(perPersonPage.text, /Ticket Types/);
  assert.match(perPersonPage.text, /\+ Add Ticket Type/);

  const csrf = extractCsrf(perPersonPage.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ pricePer: 'family', _csrf: csrf });

  const perFamilyPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.doesNotMatch(perFamilyPage.text, /Ticket Types/, 'ticket types should not be offered for a per-family-priced event');
});

test('Ticket Types: add and delete, title and price show, and this never touches the flat Price field', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { priceDollars: '5.00', pricePer: 'person' });

  let page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  let csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/ticket-types`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'VIP', priceDollars: '25.00', _csrf: csrf });

  page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.match(page.text, /VIP/);
  assert.match(page.text, /\$25\.00/);
  assert.match(page.text, /name="priceDollars" min="0" step="0.01" value="5.00"/, 'the flat Price field should be untouched by adding a ticket type');

  const ticket = await db.prepare("SELECT id FROM event_ticket_types WHERE event_id = ? AND title = 'VIP'").get(eventId);
  assert.ok(ticket);

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

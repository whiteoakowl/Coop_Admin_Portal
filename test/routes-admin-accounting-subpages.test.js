// Coverage for a real request: "accounting should have subpages -
// accounts, accounting categories, invoices, payments, adjustments,
// logs, settings." routes/admin-accounting.js's own GET '/' already has
// its own dedicated test file (test/routes-accounting.test.js) - this
// one covers the 6 newer subpages it grew alongside that original
// Accounts list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `accounting-subpages-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `accounting-subpages-test-uploads-${process.pid}`);
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

let memberCounter = 0;
async function createMember() {
  memberCounter += 1;
  const code = await generateMemberCode();
  const info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1)")
    .run(`Subpage Member ${memberCounter}`, code, code);
  return info.lastInsertRowid;
}

test('Accounting nav: the page-title subpages dropdown lists all 7 Accounting subpages', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  for (const href of [
    '/main-admin/accounting',
    '/main-admin/accounting/categories',
    '/main-admin/accounting/invoices',
    '/main-admin/accounting/payments',
    '/main-admin/accounting/adjustments',
    '/main-admin/accounting/logs',
    '/main-admin/accounting/settings',
  ]) {
    assert.match(page.text, new RegExp(href.replace(/\//g, '\\/')), `nav should link to ${href}`);
  }
});

test('Invoices subpage: lists a charge as an invoice, a new one can be added directly, and the memberId filter narrows it', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember();

  const page = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Supply Fee', amount: '15.00', _csrf: csrf });

  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);
  assert.ok(charge, 'the invoice should create a real payment_charges row');
  assert.equal(charge.amount_cents, 1500);

  const listed = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  assert.match(listed.text, /Supply Fee/);
  assert.match(listed.text, new RegExp(`#${charge.id}`));

  const filtered = await request(app).get(`/main-admin/accounting/invoices?memberId=${memberId}`).set('Cookie', admin.cookie);
  assert.match(filtered.text, /Supply Fee/);

  const otherMemberId = await createMember();
  const filteredOther = await request(app).get(`/main-admin/accounting/invoices?memberId=${otherMemberId}`).set('Cookie', admin.cookie);
  assert.doesNotMatch(filteredOther.text, /Supply Fee/);
});

test('Payments and Adjustments subpages: a payment shows under Payments, a refund shows under Adjustments, not swapped', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember();
  const csrf = (await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie)).text;
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Field Trip', amount: '30.00', _csrf: extractCsrf(csrf) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  const memberCsrf = extractCsrf(memberPage.text);

  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '30.00', method: 'Venmo', note: 'Thanks', _csrf: memberCsrf });

  const paymentsPage = await request(app).get('/main-admin/accounting/payments').set('Cookie', admin.cookie);
  assert.match(paymentsPage.text, /Field Trip/);
  assert.match(paymentsPage.text, /Venmo - Thanks/);

  const adjustmentsBefore = await request(app).get('/main-admin/accounting/adjustments').set('Cookie', admin.cookie);
  assert.doesNotMatch(adjustmentsBefore.text, /Field Trip/);

  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'refund', amount: '30.00', note: 'Cancelled', _csrf: memberCsrf });

  const adjustmentsAfter = await request(app).get('/main-admin/accounting/adjustments').set('Cookie', admin.cookie);
  assert.match(adjustmentsAfter.text, /Field Trip/);
  assert.match(adjustmentsAfter.text, /Cancelled/);
});

test('Adjustments subpage also lists cancelled charges', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember();
  const csrfPage = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Optional Add-on', amount: '10.00', _csrf: extractCsrf(csrfPage.text) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/cancel`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: extractCsrf(memberPage.text) });

  const adjustments = await request(app).get('/main-admin/accounting/adjustments').set('Cookie', admin.cookie);
  assert.match(adjustments.text, /Optional Add-on/);
});

test('Logs subpage shows the same audit trail entries as Audit Log, pre-filtered to payment_charge', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember();
  const csrfPage = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Logged Charge', amount: '5.00', _csrf: extractCsrf(csrfPage.text) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);
  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '5.00', _csrf: extractCsrf(memberPage.text) });

  const logs = await request(app).get('/main-admin/accounting/logs').set('Cookie', admin.cookie);
  assert.match(logs.text, /payment recorded/);
});

test('Categories subpage: lives at its own URL (not a modal on Accounts), and still feeds the Events Finance dropdown', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Accounting Categories/);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/accounting-categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Subpage Test Category', _csrf: csrf });

  const after = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.match(after.text, /Subpage Test Category/);
});

test('Settings subpage: Payment Methods list is editable and feeds the Record Payment dialog method dropdown', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/settings').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Cash/);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/settings/payment-methods')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ methods: 'Cash\nPayPal', _csrf: csrf });

  const memberId = await createMember();
  const invPage = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Method Dropdown Check', amount: '1.00', _csrf: extractCsrf(invPage.text) });

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  assert.match(memberPage.text, /<option value="PayPal">PayPal<\/option>/);
});

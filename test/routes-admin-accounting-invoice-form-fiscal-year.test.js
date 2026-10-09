// Coverage for a real request batch: "Add an accounting category...
// pop up that asks for title and code... Button for add a fiscal year
// asking start and end date... Accounting adjustment categories refund,
// exemption, credit, discount... Creating an invoice should look exactly
// like the screenshot" (Family/Category/Date/Due Date/Auto-Park/
// Description/Admin Notes/Amount/+Split Invoice/Email Family).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `accounting-invoice-form-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `accounting-invoice-form-test-uploads-${process.pid}`);
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
async function createMemberWithAccount(name) {
  memberCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1) RETURNING id").get(name || `Invoice Family ${memberCounter}`, code, code)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberId, `invoice-family-${memberCounter}@example.com`, hashPassword('testpassword123'));
  return memberId;
}

test('Category/Fiscal Year subpage: title+code popup, mobile-shrink table, and a Fiscal Year list with its own add popup', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Category\/Fiscal Year/);
  // No standalone inline "add category" bar left on the page - just the
  // + Add Category button that opens the popup.
  assert.doesNotMatch(page.text, /<form method="POST" action="\/main-admin\/accounting\/accounting-categories" class="stack-form">/);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/accounting-categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Registration & Renewals', code: 'RR', _csrf: csrf });
  const category = await db.prepare("SELECT * FROM event_accounting_categories WHERE name = 'Registration & Renewals'").get();
  assert.equal(category.code, 'RR');

  await request(app)
    .post('/main-admin/accounting/fiscal-years')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ startDate: '2026-07-01', endDate: '2027-06-30', _csrf: csrf });
  const fiscalYear = await db.prepare('SELECT * FROM fiscal_years').get();
  assert.ok(fiscalYear, 'the fiscal year should be recorded');
  assert.equal(fiscalYear.start_date, '2026-07-01');
  assert.equal(fiscalYear.end_date, '2027-06-30');

  const after = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.match(after.text, /2026-07-01/);
  assert.match(after.text, /2027-06-30/);

  // Deleting the fiscal year works too.
  await request(app)
    .post(`/main-admin/accounting/fiscal-years/${fiscalYear.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM fiscal_years WHERE id = ?').get(fiscalYear.id), undefined);
});

test('New/Edit Invoice form: Family read-only, Category/Due Date/Admin Notes/Auto-Park persist, Split Invoice creates a 2nd charge, Email Family sends a notification', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMemberWithAccount('Kara Kalna');
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

  const categoriesPage = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/accounting-categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Invoice Form Category', code: 'RR', _csrf: extractCsrf(categoriesPage.text) });
  const category = await db.prepare("SELECT * FROM event_accounting_categories WHERE name = 'Invoice Form Category'").get();

  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${memberId}`).set('Cookie', admin.cookie);
  assert.equal(newInvoicePage.status, 200);
  // "Family (read-only, 'Kalna, Kara')" - Last, First, not this app's
  // usual stored "First Last".
  assert.match(newInvoicePage.text, /value="Kalna, Kara"/);
  assert.match(newInvoicePage.text, /readonly/);

  const createRes = await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      categoryId: String(category.id),
      date: '2026-10-08',
      dueDate: '2026-10-11',
      autoParkFamily: '1',
      description: 'Annual Group Membership',
      adminNotes: 'Paid by check at orientation.',
      amount: '20.00',
      splitDescription: ['Materials Fee'],
      splitAmount: ['5.00'],
      emailFamily: 'yes',
      _csrf: extractCsrf(newInvoicePage.text),
    });
  assert.match(createRes.headers.location, /\/main-admin\/accounting\/invoices\?notice=/);

  const charges = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ? ORDER BY id').all(memberId);
  assert.equal(charges.length, 2, 'the primary Description/Amount and the one +Split Invoice line item should each be their own charge');
  const main = charges.find((c) => c.description === 'Annual Group Membership');
  const split = charges.find((c) => c.description === 'Materials Fee');
  assert.equal(main.amount_cents, 2000);
  assert.equal(main.accounting_category_id, category.id);
  assert.equal(main.due_date, '2026-10-11');
  assert.equal(main.admin_notes, 'Paid by check at orientation.');
  assert.equal(main.auto_park_family, true);
  assert.equal(main.created_at.slice(0, 10), '2026-10-08');
  assert.equal(split.amount_cents, 500);
  assert.equal(split.accounting_category_id, category.id, 'the split line item should share the same category/dates/notes/auto-park');

  // "Email Family?" - a real in-app notification, not a no-op.
  const campaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject LIKE 'New Invoice%'").get();
  assert.ok(campaign, 'choosing Email Family: Yes should actually send a notification');

  // Edit Invoice: same full form, pre-filled, Update Invoice saves changes.
  const editPage = await request(app).get(`/main-admin/accounting/invoices/${main.id}/edit`).set('Cookie', admin.cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`Edit Invoice #${main.id}`));
  assert.match(editPage.text, /Annual Group Membership/);
  assert.match(editPage.text, /checked/); // auto-park checkbox pre-checked

  await request(app)
    .post(`/main-admin/accounting/invoices/${main.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      description: 'Annual Group Membership (Updated)',
      amount: '22.00',
      categoryId: String(category.id),
      date: '2026-10-08',
      dueDate: '2026-10-15',
      autoParkFamily: '',
      emailFamily: 'no',
      _csrf: extractCsrf(editPage.text),
    });
  const updated = await db.prepare('SELECT * FROM payment_charges WHERE id = ?').get(main.id);
  assert.equal(updated.description, 'Annual Group Membership (Updated)');
  assert.equal(updated.amount_cents, 2200);
  assert.equal(updated.due_date, '2026-10-15');
  assert.equal(updated.auto_park_family, false);
});

test('Auto-Park/Unpark: an overdue auto-park invoice parks the family; paying it off unparks them', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMemberWithAccount('Pat Parked');

  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      dueDate: '2020-01-01', // long overdue
      autoParkFamily: '1',
      description: 'Overdue Fee',
      amount: '10.00',
      _csrf: extractCsrf(newInvoicePage.text),
    });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);
  assert.ok((await db.prepare('SELECT parked FROM members WHERE id = ?').get(memberId)).parked, 'an overdue auto-park invoice should park the family');

  const accountsPage = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.match(accountsPage.text, /Parked/);

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '10.00', _csrf: extractCsrf(memberPage.text) });

  assert.equal((await db.prepare('SELECT parked FROM members WHERE id = ?').get(memberId)).parked, false, 'paying off the overdue invoice should unpark the family');
});

test('Adjustment Type: a refund records refund/exemption/credit/discount, shown on Adjustments and the member Account page', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMemberWithAccount('Credit Case');
  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Workshop Fee', amount: '40.00', _csrf: extractCsrf(newInvoicePage.text) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);
  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '40.00', _csrf: extractCsrf(memberPage.text) });
  const memberPage2 = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'refund', amount: '40.00', adjustmentType: 'credit', _csrf: extractCsrf(memberPage2.text) });

  const refund = await db.prepare('SELECT * FROM payment_payments WHERE charge_id = ? AND amount_cents < 0').get(charge.id);
  assert.equal(refund.adjustment_type, 'credit');

  const adjustmentsPage = await request(app).get('/main-admin/accounting/adjustments').set('Cookie', admin.cookie);
  assert.match(adjustmentsPage.text, /Credit/);

  const memberPage3 = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  assert.match(memberPage3.text, /Credit/);
});

test('Accounts page toolbar: no more Past Due Only filter checkbox - two action buttons instead, each emailing a different audience', async () => {
  const admin = await loginAsMainAdmin();
  const pastDueMemberId = await createMemberWithAccount('Owes Money');
  const paidUpMemberId = await createMemberWithAccount('Paid Up Member');

  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${pastDueMemberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(pastDueMemberId), description: 'Unpaid Fee', amount: '15.00', _csrf: extractCsrf(newInvoicePage.text) });

  const newInvoicePage2 = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${paidUpMemberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(paidUpMemberId), description: 'Paid Fee', amount: '15.00', _csrf: extractCsrf(newInvoicePage2.text) });
  const paidCharge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(paidUpMemberId);
  const memberPage = await request(app).get(`/main-admin/accounting/members/${paidUpMemberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${paidCharge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '15.00', _csrf: extractCsrf(memberPage.text) });

  const accountsPage = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.doesNotMatch(accountsPage.text, /Past Due Only/);
  assert.match(accountsPage.text, /Email All Past Due Invoices/);
  assert.match(accountsPage.text, /Email All Invoices/);
  const csrf = extractCsrf(accountsPage.text);

  const pastDueAccountId = (await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(pastDueMemberId)).id;
  const paidUpAccountId = (await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(paidUpMemberId)).id;

  await request(app)
    .post('/main-admin/accounting/email-all-past-due-invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  const pastDueCampaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject = 'Accounting Statement - Balance Due' ORDER BY id DESC").get();
  const pastDueRecipients = JSON.parse(pastDueCampaign.recipient_account_ids);
  assert.ok(pastDueRecipients.includes(pastDueAccountId), 'the still-unpaid member should get the past-due reminder');
  assert.ok(!pastDueRecipients.includes(paidUpAccountId), 'the paid-up member should not get the past-due reminder');

  await request(app)
    .post('/main-admin/accounting/email-all-invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  const allCampaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject = 'Accounting Statement' ORDER BY id DESC").get();
  const allRecipients = JSON.parse(allCampaign.recipient_account_ids);
  assert.ok(allRecipients.includes(pastDueAccountId) && allRecipients.includes(paidUpAccountId), 'Email All Invoices should reach every billable member, paid up or not');
});

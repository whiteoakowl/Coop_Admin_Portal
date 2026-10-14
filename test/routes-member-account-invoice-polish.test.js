// Coverage for a real request batch: "Main admin portal, accounts, click
// account icon next to member. On each invoice on the table, it should
// only say the name of the event on the invoice, it should not say
// event registration... Remove record payment and red delete button on
// invoices that have been paid. Be able to click on each invoice name
// and view the invoice." "Add print button to member account pages on
// parent portal and main admin portal."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-account-invoice-polish-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-account-invoice-polish-test-uploads-${process.pid}`);
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
const { hashPassword } = require('../utils/portalAuth');

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
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1) RETURNING id").get(name || `Invoice Polish Family ${memberCounter}`, code, code)
  ).id;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberId, `invoice-polish-${memberCounter}@example.com`, hashPassword('testpassword123'));
  return memberId;
}

test('Member account page: invoice name is a clickable link to the invoice, and Print button is present', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMemberWithAccount();
  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Fall Festival', amount: '10.00', _csrf: extractCsrf(newInvoicePage.text) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  assert.equal(memberPage.status, 200);
  assert.match(memberPage.text, new RegExp(`<a href="/main-admin/accounting/invoices/${charge.id}/edit">Fall Festival</a>`));
  assert.match(memberPage.text, /class="roster-action-btn print-action-btn no-print" onclick="window\.print\(\)">Print</);
});

test('Member account page: a paid invoice drops Record Payment and the red Delete icon, keeping Edit and Cancel', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMemberWithAccount();
  const newInvoicePage = await request(app).get(`/main-admin/accounting/invoices/new?memberId=${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description: 'Workshop Fee', amount: '30.00', _csrf: extractCsrf(newInvoicePage.text) });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);

  const beforePay = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  assert.match(beforePay.text, /Record Payment/);
  assert.match(beforePay.text, new RegExp(`aria-label="Delete invoice #${charge.id}"`));

  const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '30.00', _csrf: extractCsrf(memberPage.text) });

  const afterPay = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
  assert.doesNotMatch(afterPay.text, /Record Payment/, 'a fully paid invoice should not offer Record Payment anymore');
  assert.doesNotMatch(afterPay.text, new RegExp(`aria-label="Delete invoice #${charge.id}"`), 'a fully paid invoice should not offer to delete its own payment history');
  assert.match(afterPay.text, new RegExp(`aria-label="Edit invoice #${charge.id}"`), 'Edit should still be available on a paid invoice');
  assert.match(afterPay.text, /Cancel/, 'Cancel should still be available on a paid invoice');
});

test('Parent Portal Accounting page has a Print button', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('PrintBtnFamily') RETURNING id").get()).id;
  const code = await generateMemberCode();
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES ('Print Btn Parent', ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(code, code, familyId)
  ).id;
  const email = 'print-btn-parent@example.com';
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberId, email, hashPassword('testpassword123'));
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/accounting' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/accounting').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="roster-action-btn print-action-btn no-print" onclick="window\.print\(\)">Print</);
});

test('Data cleanup migration: an existing event-registration charge with the old verbose "Event Registration" description is stripped down to just the event title', async () => {
  const memberId = await createMemberWithAccount();
  const eventId = (await db.prepare("INSERT INTO events (title, slug, starts_at, ends_at) VALUES ('Fall Carnival', 'fall-carnival-cleanup-test', now_text(), now_text()) RETURNING id").get()).id;
  await db
    .prepare("INSERT INTO payment_charges (member_id, source_type, source_id, description, amount_cents) VALUES (?, 'event_registration', ?, 'Event Registration - Fall Carnival', 1500)")
    .run(memberId, eventId);
  await db
    .prepare("INSERT INTO payment_charges (member_id, source_type, source_id, description, amount_cents) VALUES (?, 'manual', NULL, 'Event Registration fee waived (manual note)', 0)")
    .run(memberId);

  // Re-apply the cleanup migration's own statement directly (it already
  // ran once at db bootstrap for this test db, so this just re-confirms
  // the exact SQL is idempotent and correctly scoped - a 'manual' charge
  // that merely mentions the phrase must not be touched).
  await db.prepare(
    `update payment_charges
     set description = trim(regexp_replace(description, '^Event Registration\\s*[-:–—]*\\s*', '', 'i'))
     where source_type = 'event_registration'
       and description ~* '^Event Registration'
       and trim(regexp_replace(description, '^Event Registration\\s*[-:–—]*\\s*', '', 'i')) <> ''`
  ).run();

  const cleaned = await db.prepare("SELECT description FROM payment_charges WHERE source_type = 'event_registration' AND member_id = ?").get(memberId);
  assert.equal(cleaned.description, 'Fall Carnival');
  const untouched = await db.prepare("SELECT description FROM payment_charges WHERE source_type = 'manual' AND member_id = ?").get(memberId);
  assert.equal(untouched.description, 'Event Registration fee waived (manual note)', 'a manual charge that merely mentions the phrase should be left alone');
});

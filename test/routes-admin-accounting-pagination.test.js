// Coverage for pagination added to routes/admin-accounting.js (Accounts,
// Invoices, Payments, Adjustments, Logs) - same shared utils/pagination.js
// convention every other admin list/log page already uses (see
// test/routes-logs-pagination.test.js, test/routes-members-pagination.test.js).
// Minimal per-route checks only: with more than DEFAULT_PAGE_SIZE items,
// page 1 shows only DEFAULT_PAGE_SIZE of them and the pagination controls
// render. The pagination math itself is already covered by
// test/pagination.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-accounting-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-accounting-pagination-test-uploads-${process.pid}`);
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
const { DEFAULT_PAGE_SIZE } = require('../utils/pagination');

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

const EXTRA = 5;
const TOTAL = DEFAULT_PAGE_SIZE + EXTRA;

let memberCounter = 0;
async function createMember(prefix) {
  memberCounter += 1;
  const code = await generateMemberCode();
  const info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'student', 1)")
    .run(`${prefix} ${memberCounter}`, code, code);
  return info.lastInsertRowid;
}

async function createInvoiceCharge(admin, memberId, description, amount) {
  await request(app)
    .post('/main-admin/accounting/invoices')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), description, amount, _csrf: admin.csrfToken });
  return db.prepare('SELECT * FROM payment_charges WHERE member_id = ? AND description = ?').get(memberId, description);
}

// Shared assertions every case below needs: exactly DEFAULT_PAGE_SIZE rows
// render on page 1 (not TOTAL), and the pagination partial's own controls
// (a "Page ... of N" select plus a page=2 link) are present. `rowMatcher`
// is either a plain needle counted with split() (fine when it appears
// exactly once per row), or a RegExp with the 'g' flag (needed when a
// plain needle - e.g. a member's name - also repeats inside that same
// row's own aria-label/title attributes, like the Accounts list's own
// row icons).
function assertPaginated(text, rowMatcher, pageParam = 'page') {
  const rowCount = rowMatcher instanceof RegExp ? (text.match(rowMatcher) || []).length : text.split(rowMatcher).length - 1;
  assert.equal(rowCount, DEFAULT_PAGE_SIZE, `expected exactly ${DEFAULT_PAGE_SIZE} rows on page 1, got ${rowCount}`);
  assert.match(text, /pagination-page-select/, 'pagination controls should render');
  assert.match(text, new RegExp(`${pageParam}=2`), 'a link/option to page 2 should be present');
}

test('Accounts list paginates: page 1 shows only DEFAULT_PAGE_SIZE members, with pagination controls', async () => {
  const admin = await loginAsMainAdmin();
  for (let i = 0; i < TOTAL; i++) await createMember('Paginate Account');

  const nameAnchor = />Paginate Account \d+<\/a>/g;
  const page1 = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assertPaginated(page1.text, nameAnchor);

  const page2 = await request(app).get('/main-admin/accounting?page=2').set('Cookie', admin.cookie);
  assert.equal(page2.status, 200);
  const page2Rows = (page2.text.match(nameAnchor) || []).length;
  assert.equal(page2Rows, EXTRA, 'the remaining 5 members should land on page 2');
});

test('Invoices subpage paginates: page 1 shows only DEFAULT_PAGE_SIZE invoices, with pagination controls', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember('Paginate Invoice Member');
  for (let i = 0; i < TOTAL; i++) {
    await createInvoiceCharge(admin, memberId, `Paginate Invoice Item ${i}`, '1.00');
  }

  const page1 = await request(app).get('/main-admin/accounting/invoices').set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assertPaginated(page1.text, 'Paginate Invoice Item');
});

test('Payments subpage paginates: page 1 shows only DEFAULT_PAGE_SIZE payments, with pagination controls', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember('Paginate Payment Member');
  for (let i = 0; i < TOTAL; i++) {
    const charge = await createInvoiceCharge(admin, memberId, `Paginate Payment Charge ${i}`, '1.00');
    const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
    await request(app)
      .post(`/main-admin/accounting/charges/${charge.id}/payments`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ direction: 'payment', amount: '1.00', note: `Pagination Note ${i}`, _csrf: extractCsrf(memberPage.text) });
  }

  const page1 = await request(app).get('/main-admin/accounting/payments').set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assertPaginated(page1.text, 'Paginate Payment Charge');
});

test('Adjustments subpage paginates both Refunds and Cancelled Charges independently, each with its own page param', async () => {
  const admin = await loginAsMainAdmin();
  const refundMemberId = await createMember('Paginate Refund Member');
  for (let i = 0; i < TOTAL; i++) {
    const charge = await createInvoiceCharge(admin, refundMemberId, `Paginate Refund Charge ${i}`, '1.00');
    const memberPage = await request(app).get(`/main-admin/accounting/members/${refundMemberId}`).set('Cookie', admin.cookie);
    const csrf = extractCsrf(memberPage.text);
    await request(app)
      .post(`/main-admin/accounting/charges/${charge.id}/payments`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ direction: 'payment', amount: '1.00', _csrf: csrf });
    const memberPage2 = await request(app).get(`/main-admin/accounting/members/${refundMemberId}`).set('Cookie', admin.cookie);
    await request(app)
      .post(`/main-admin/accounting/charges/${charge.id}/payments`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ direction: 'refund', amount: '1.00', _csrf: extractCsrf(memberPage2.text) });
  }

  const cancelMemberId = await createMember('Paginate Cancelled Member');
  for (let i = 0; i < TOTAL; i++) {
    const charge = await createInvoiceCharge(admin, cancelMemberId, `Paginate Cancelled Charge ${i}`, '1.00');
    const memberPage = await request(app).get(`/main-admin/accounting/members/${cancelMemberId}`).set('Cookie', admin.cookie);
    await request(app)
      .post(`/main-admin/accounting/charges/${charge.id}/cancel`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: extractCsrf(memberPage.text) });
  }

  const page1 = await request(app).get('/main-admin/accounting/adjustments').set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assertPaginated(page1.text, 'Paginate Refund Charge', 'refundsPage');
  assertPaginated(page1.text, 'Paginate Cancelled Charge', 'cancelledPage');

  // Paging through Refunds (its own ?refundsPage=2) must not disturb
  // Cancelled Charges' own page 1.
  const refundsPage2 = await request(app).get('/main-admin/accounting/adjustments?refundsPage=2').set('Cookie', admin.cookie);
  assert.equal(refundsPage2.text.split('Paginate Refund Charge').length - 1, EXTRA);
  assert.equal(refundsPage2.text.split('Paginate Cancelled Charge').length - 1, DEFAULT_PAGE_SIZE);
});

test('Logs subpage paginates: page 1 shows only DEFAULT_PAGE_SIZE audit entries, with pagination controls', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember('Paginate Log Member');
  for (let i = 0; i < TOTAL; i++) {
    const charge = await createInvoiceCharge(admin, memberId, `Paginate Log Charge ${i}`, '1.00');
    const memberPage = await request(app).get(`/main-admin/accounting/members/${memberId}`).set('Cookie', admin.cookie);
    await request(app)
      .post(`/main-admin/accounting/charges/${charge.id}/payments`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ direction: 'payment', amount: '1.00', note: `Paginate Log Note ${i}`, _csrf: extractCsrf(memberPage.text) });
  }

  const page1 = await request(app).get('/main-admin/accounting/logs').set('Cookie', admin.cookie);
  assert.equal(page1.status, 200);
  assertPaginated(page1.text, 'Paginate Log Note');
});

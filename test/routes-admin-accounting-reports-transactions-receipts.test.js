// Coverage for a real request: "Main admin portal, accounting. Add a
// subpage called reports... Add a subpage called transactions... Add a
// subpage called receipts." Transactions are manual-entry only (the
// answered scoping question - no real bank-link provider exists
// anywhere in this app); Reports are computed directly from
// accounting_transactions; Receipts is the same Transactions data,
// pre-filtered to rows that actually have a receipt image attached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `accounting-reports-tx-receipts-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `accounting-reports-tx-receipts-test-uploads-${process.pid}`);
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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('Accounting nav: lists Reports, Transactions, and Receipts', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.match(page.text, /\/main-admin\/accounting\/reports/);
  assert.match(page.text, /\/main-admin\/accounting\/transactions/);
  assert.match(page.text, /\/main-admin\/accounting\/receipts/);
});

test('Transactions: add income and expense, filter by type and date range, update category, delete', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/transactions').set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/transactions')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'income', name: 'Member Dues', transactionDate: '2026-09-01', amount: '100.00', _csrf: csrf });

  await request(app)
    .post('/main-admin/accounting/transactions')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'expense', name: 'Classroom Supplies Run', transactionDate: '2026-09-15', amount: '25.50', _csrf: csrf });

  const listed = await request(app).get('/main-admin/accounting/transactions').set('Cookie', admin.cookie);
  assert.match(listed.text, /Member Dues/);
  assert.match(listed.text, /Classroom Supplies Run/);
  assert.match(listed.text, /\$100\.00/);
  assert.match(listed.text, /\$25\.50/);

  const incomeOnly = await request(app).get('/main-admin/accounting/transactions?type=income').set('Cookie', admin.cookie);
  assert.match(incomeOnly.text, /Member Dues/);
  assert.doesNotMatch(incomeOnly.text, /Classroom Supplies Run/);

  const rangeOnly = await request(app).get('/main-admin/accounting/transactions?startDate=2026-09-10&endDate=2026-09-30').set('Cookie', admin.cookie);
  assert.match(rangeOnly.text, /Classroom Supplies Run/);
  assert.doesNotMatch(rangeOnly.text, /Member Dues/);

  const expenseTxn = await db.prepare("SELECT * FROM accounting_transactions WHERE name = 'Classroom Supplies Run'").get();
  const category = await db.prepare('SELECT * FROM event_accounting_categories ORDER BY position, name LIMIT 1').get();
  if (category) {
    await request(app)
      .post(`/main-admin/accounting/transactions/${expenseTxn.id}/category`)
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ accountingCategoryId: String(category.id), _csrf: csrf });
    const updated = await db.prepare('SELECT accounting_category_id FROM accounting_transactions WHERE id = ?').get(expenseTxn.id);
    assert.equal(updated.accounting_category_id, category.id);
  }

  const incomeTxn = await db.prepare("SELECT * FROM accounting_transactions WHERE name = 'Member Dues'").get();
  await request(app)
    .post(`/main-admin/accounting/transactions/${incomeTxn.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  assert.equal(await db.prepare('SELECT 1 FROM accounting_transactions WHERE id = ?').get(incomeTxn.id), undefined);
});

test('Transactions: a receipt image can be uploaded to an expense and is served back, then shows up on Receipts', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/transactions').set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post('/main-admin/accounting/transactions')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'expense', name: 'Receipted Purchase', transactionDate: '2026-10-01', amount: '40.00', _csrf: csrf });
  const txn = await db.prepare("SELECT * FROM accounting_transactions WHERE name = 'Receipted Purchase'").get();

  const receiptsBefore = await request(app).get('/main-admin/accounting/receipts').set('Cookie', admin.cookie);
  assert.doesNotMatch(receiptsBefore.text, /Receipted Purchase/);

  await request(app)
    .post(`/main-admin/accounting/transactions/${txn.id}/receipt?_csrf=` + encodeURIComponent(csrf))
    .set('Cookie', admin.cookie)
    .field('_csrf', csrf)
    .attach('receipt', PNG_1X1, { filename: 'receipt.png', contentType: 'image/png' });

  const stored = await db.prepare('SELECT * FROM accounting_transactions WHERE id = ?').get(txn.id);
  assert.ok(stored.receipt_key, 'receipt_key should be set after upload');

  const fileRes = await request(app).get(`/main-admin/accounting/transactions/${txn.id}/receipt/file`).set('Cookie', admin.cookie);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers['content-type'], 'image/png');

  const receiptsAfter = await request(app).get('/main-admin/accounting/receipts').set('Cookie', admin.cookie);
  assert.match(receiptsAfter.text, /Receipted Purchase/);
});

test('Reports: index links to all 3 reports, and each computes real numbers from Transactions', async () => {
  const admin = await loginAsMainAdmin();
  const index = await request(app).get('/main-admin/accounting/reports').set('Cookie', admin.cookie);
  assert.match(index.text, /\/main-admin\/accounting\/reports\/profit-and-loss/);
  assert.match(index.text, /\/main-admin\/accounting\/reports\/balance-sheet/);
  assert.match(index.text, /\/main-admin\/accounting\/reports\/cash-flow/);

  const page = await request(app).get('/main-admin/accounting/transactions').set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);
  await request(app)
    .post('/main-admin/accounting/transactions')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'income', name: 'Report Income', transactionDate: '2026-11-01', amount: '200.00', _csrf: csrf });
  await request(app)
    .post('/main-admin/accounting/transactions')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ type: 'expense', name: 'Report Expense', transactionDate: '2026-11-02', amount: '75.00', _csrf: csrf });

  const pl = await request(app).get('/main-admin/accounting/reports/profit-and-loss?startDate=2026-11-01&endDate=2026-11-30').set('Cookie', admin.cookie);
  assert.match(pl.text, /\$200\.00/);
  assert.match(pl.text, /\$75\.00/);
  assert.match(pl.text, /\$125\.00/);

  const cashFlow = await request(app).get('/main-admin/accounting/reports/cash-flow?startDate=2026-11-01&endDate=2026-11-30').set('Cookie', admin.cookie);
  assert.match(cashFlow.text, /\$200\.00/);
  assert.match(cashFlow.text, /\$75\.00/);
  assert.match(cashFlow.text, /\$125\.00/);

  const balanceSheet = await request(app).get('/main-admin/accounting/reports/balance-sheet?asOfDate=2026-11-30').set('Cookie', admin.cookie);
  assert.equal(balanceSheet.status, 200);
  assert.match(balanceSheet.text, /Cash/);
});

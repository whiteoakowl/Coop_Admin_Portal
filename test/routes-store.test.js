// Route-level coverage for Store (Community & Commerce track, item 8).
// See utils/store.js's own comments and supabase/migrations/
// 20260825090000_store.sql for the design this exercises: checkout
// wired through the payment_charges abstraction, an in-person sale
// recorded distinctly from an online order (paid immediately, through
// its own dedicated admin action), and live inventory checks that never
// trust a client-sent quantity.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `store-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `store-test-uploads-${process.pid}`);
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
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const payments = require('../utils/payments');

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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, code, code, familyId);
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/store' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/store').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

async function createActiveProduct(admin, overrides = {}) {
  const createRes = await request(app)
    .post('/main-admin/store')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Co-op T-Shirt', price: '15.00', availability: 'both', ...overrides, _csrf: admin.csrfToken });
  const productId = /\/main-admin\/store\/(\d+)\/edit/.exec(createRes.headers.location)[1];
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: admin.csrfToken });
  return productId;
}

test('store requires sign-in', async () => {
  const res = await request(app).get('/store');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('an online order starts pending and creates a real charge in Accounting', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createActiveProduct(admin);
  const parent = await createParentAccount();

  const buyRes = await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '2', _csrf: parent.csrfToken });
  const orderId = /\/store\/orders\/(\d+)/.exec(buyRes.headers.location)[1];

  const order = await db.prepare('SELECT * FROM store_orders WHERE id = ?').get(orderId);
  assert.equal(order.status, 'pending');
  assert.equal(order.sale_type, 'online');
  assert.equal(order.total_cents, 3000);

  const charge = await payments.getCharge(order.charge_id);
  assert.equal(charge.status, 'pending');
  assert.equal(charge.amount_cents, 3000);
  assert.equal(await payments.balanceForMember(parent.memberId), 3000);
});

test('an in-person sale is recorded as paid immediately, distinct from an online order', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createActiveProduct(admin, { name: 'Snack' });
  const parent = await createParentAccount();

  const saleRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), productId, quantity: '1', _csrf: admin.csrfToken });
  assert.equal(saleRes.status, 302);

  const order = await db.prepare("SELECT * FROM store_orders WHERE member_id = ? AND sale_type = 'in_person'").get(parent.memberId);
  assert.equal(order.status, 'paid');

  const charge = await payments.getCharge(order.charge_id);
  assert.equal(charge.status, 'paid');
  assert.equal(await payments.balanceForMember(parent.memberId), 0);
});

test('inventory is checked live and decremented, rejecting an order that exceeds stock', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createActiveProduct(admin, { name: 'Limited Item', inventoryCount: '1' });
  const parent = await createParentAccount();

  const tooMany = await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '2', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(tooMany.headers.location), /Only 1 of/);

  await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });

  const product = await db.prepare('SELECT inventory_count FROM store_products WHERE id = ?').get(productId);
  assert.equal(product.inventory_count, 0);
});

test('cancelling an order restores inventory and cancels its charge instead of leaving it owed', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createActiveProduct(admin, { name: 'Cancel Me', inventoryCount: '5' });
  const parent = await createParentAccount();

  const buyRes = await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '2', _csrf: parent.csrfToken });
  const orderId = /\/store\/orders\/(\d+)/.exec(buyRes.headers.location)[1];

  await request(app).post(`/main-admin/store/orders/${orderId}/cancel`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const order = await db.prepare('SELECT status, charge_id FROM store_orders WHERE id = ?').get(orderId);
  assert.equal(order.status, 'cancelled');
  const charge = await payments.getCharge(order.charge_id);
  assert.equal(charge.status, 'cancelled');
  assert.equal(await payments.balanceForMember(parent.memberId), 0);

  const product = await db.prepare('SELECT inventory_count FROM store_products WHERE id = ?').get(productId);
  assert.equal(product.inventory_count, 5);
});

test('an account cannot buy for a member outside its own family, and cannot view another family\'s order', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createActiveProduct(admin);
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), quantity: '1', _csrf: parentA.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /You can only buy for yourself or your own family/);

  const buyRes = await request(app)
    .post(`/store/${productId}/buy`)
    .set('Cookie', parentB.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), quantity: '1', _csrf: parentB.csrfToken });
  const orderId = /\/store\/orders\/(\d+)/.exec(buyRes.headers.location)[1];

  const view = await request(app).get(`/store/orders/${orderId}`).set('Cookie', parentA.cookie);
  assert.equal(view.status, 403);
});

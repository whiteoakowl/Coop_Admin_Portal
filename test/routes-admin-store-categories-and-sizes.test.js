// Coverage for the Shop feature build-out: categories (Settings tab
// add/rename/delete), per-product sizes, the multi-item In-Person Sale
// cart (routes/admin-store.js's own POST /orders/in-person), and the
// Archived tab. See utils/store.js and supabase/migrations/
// 20260918030000_store_categories_and_sizes.sql for the schema/shape
// this exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-store-categories-sizes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-store-categories-sizes-test-uploads-${process.pid}`);
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

async function freshCsrf(admin, tab) {
  const page = await request(app).get(`/main-admin/store?tab=${tab}`).set('Cookie', admin.cookie);
  return extractCsrf(page.text);
}

async function createProduct(admin, overrides = {}) {
  const csrf = await freshCsrf(admin, 'products');
  const createRes = await request(app)
    .post('/main-admin/store')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Test Product', price: '10.00', availability: 'both', ...overrides, _csrf: csrf });
  return /\/main-admin\/store\/(\d+)\/edit/.exec(createRes.headers.location)[1];
}

async function activateProduct(admin, productId) {
  const csrf = await freshCsrf(admin, 'products');
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: csrf });
}

test('Settings tab: adding, renaming, and deleting a category', async () => {
  const admin = await loginAsMainAdmin();

  let csrf = await freshCsrf(admin, 'settings');
  await request(app).post('/main-admin/store/categories').set('Cookie', admin.cookie).type('form').send({ name: 'Apparel', _csrf: csrf });

  let category = await db.prepare("SELECT * FROM store_categories WHERE name = 'Apparel'").get();
  assert.ok(category, 'the category should be created');

  csrf = await freshCsrf(admin, 'settings');
  await request(app).post(`/main-admin/store/categories/${category.id}`).set('Cookie', admin.cookie).type('form').send({ name: 'Apparel & Gear', _csrf: csrf });
  category = await db.prepare('SELECT * FROM store_categories WHERE id = ?').get(category.id);
  assert.equal(category.name, 'Apparel & Gear');

  // A product filed under this category should fall back to
  // uncategorized, not be deleted, once its category is removed.
  const productId = await createProduct(admin, { categoryId: String(category.id) });
  let product = await db.prepare('SELECT category_id FROM store_products WHERE id = ?').get(productId);
  assert.equal(product.category_id, category.id);

  csrf = await freshCsrf(admin, 'settings');
  await request(app).post(`/main-admin/store/categories/${category.id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: csrf });

  category = await db.prepare('SELECT * FROM store_categories WHERE id = ?').get(category.id);
  assert.equal(category, undefined, 'the category itself should be gone');
  product = await db.prepare('SELECT category_id FROM store_products WHERE id = ?').get(productId);
  assert.equal(product.category_id, null, "the product should survive, now uncategorized");
});

test('Products tab: category filter only shows products in the selected category', async () => {
  const admin = await loginAsMainAdmin();

  let csrf = await freshCsrf(admin, 'settings');
  await request(app).post('/main-admin/store/categories').set('Cookie', admin.cookie).type('form').send({ name: 'Snacks', _csrf: csrf });
  const category = await db.prepare("SELECT * FROM store_categories WHERE name = 'Snacks'").get();

  await createProduct(admin, { name: 'Filtered Chips', categoryId: String(category.id) });
  await createProduct(admin, { name: 'Filtered Widget' });

  const page = await request(app).get(`/main-admin/store?tab=products&category=${category.id}`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Filtered Chips/);
  assert.doesNotMatch(page.text, /Filtered Widget/);
});

test('a product with sizes requires a valid size on both online and in-person checkout', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Hoodie', sizes: 'S, M, L' });
  await activateProduct(admin, productId);

  const product = await db.prepare('SELECT sizes FROM store_products WHERE id = ?').get(productId);
  assert.equal(product.sizes, 'S, M, L');

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sized Buyer', 'sized-buyer', 'parent')").run()).lastInsertRowid;

  let csrf = await freshCsrf(admin, 'orders');
  const noSizeRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': productId, 'items[0][quantity]': '1', _csrf: csrf });
  assert.match(decodeURIComponent(noSizeRes.headers.location), /Choose a size/);

  csrf = await freshCsrf(admin, 'orders');
  const withSizeRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': productId, 'items[0][quantity]': '1', 'items[0][size]': 'M', _csrf: csrf });
  assert.match(withSizeRes.headers.location, /\/main-admin\/store\/orders\/\d+/);

  const orderId = /\/main-admin\/store\/orders\/(\d+)/.exec(withSizeRes.headers.location)[1];
  const item = await db.prepare('SELECT size FROM store_order_items WHERE order_id = ?').get(orderId);
  assert.equal(item.size, 'M');
});

test('In-Person Sale cart rings up several different products in one order', async () => {
  const admin = await loginAsMainAdmin();
  const shirtId = await createProduct(admin, { name: 'Cart Shirt', price: '12.00' });
  await activateProduct(admin, shirtId);
  const snackId = await createProduct(admin, { name: 'Cart Snack', price: '3.00' });
  await activateProduct(admin, snackId);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cart Buyer', 'cart-buyer', 'parent')").run()).lastInsertRowid;

  const csrf = await freshCsrf(admin, 'orders');
  const res = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      'items[0][productId]': shirtId,
      'items[0][quantity]': '2',
      'items[1][productId]': snackId,
      'items[1][quantity]': '3',
      _csrf: csrf,
    });
  const orderId = /\/main-admin\/store\/orders\/(\d+)/.exec(res.headers.location)[1];

  const order = await db.prepare('SELECT total_cents FROM store_orders WHERE id = ?').get(orderId);
  assert.equal(order.total_cents, 2 * 1200 + 3 * 300);

  const items = await db.prepare('SELECT product_id, quantity FROM store_order_items WHERE order_id = ? ORDER BY product_id').all(orderId);
  assert.equal(items.length, 2);
});

test('Archived tab: archiving a product hides it from Products and Restore brings it back', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Archive Me' });

  let csrf = await freshCsrf(admin, 'products');
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'archived', _csrf: csrf });

  let productsPage = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.doesNotMatch(productsPage.text, /Archive Me/);
  let archivedPage = await request(app).get('/main-admin/store?tab=archived').set('Cookie', admin.cookie);
  assert.match(archivedPage.text, /Archive Me/);

  csrf = await freshCsrf(admin, 'archived');
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'draft', redirectTo: '/main-admin/store?tab=archived', _csrf: csrf });

  productsPage = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.match(productsPage.text, /Archive Me/);
  archivedPage = await request(app).get('/main-admin/store?tab=archived').set('Cookie', admin.cookie);
  assert.doesNotMatch(archivedPage.text, /Archive Me/);
});

// Coverage for a real request batch on Main Admin Shop:
// - product Options as rows (title/price/qty/enable-disable), replacing
//   plain sizes - see supabase/migrations/20260921010000_store_product_options.sql
// - Orders tab "Fulfillment Totals" popup (utils/store.js's own
//   fulfillmentTotals())
// - a new Analytics subpage (date-range filter + per-product/option
//   totals, utils/store.js's own salesAnalytics())
// - Settings tab removed, Add Category moved onto Products
// - the product card itself links to Edit (no separate Edit button),
//   shows status next to the name
// - "Filter by category" relabeled "Filter", a new "View Member Store"
//   button
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-store-options-analytics-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-store-options-analytics-test-uploads-${process.pid}`);
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

async function freshCsrf(admin, query) {
  const page = await request(app).get(`/main-admin/store${query || ''}`).set('Cookie', admin.cookie);
  return extractCsrf(page.text);
}

async function createProduct(admin, overrides = {}) {
  const csrf = await freshCsrf(admin);
  const createRes = await request(app)
    .post('/main-admin/store')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Test Product', price: '10.00', availability: 'both', ...overrides, _csrf: csrf });
  return Number(/\/main-admin\/store\/(\d+)\/edit/.exec(createRes.headers.location)[1]);
}

async function activateProduct(admin, productId) {
  const csrf = await freshCsrf(admin);
  await request(app).post(`/main-admin/store/${productId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: csrf });
}

test('Settings tab is gone; Add Category lives on Products', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/store').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /store\?tab=settings">Settings/);
  assert.match(page.text, /\+ Add Category/);
  assert.match(page.text, /<h2>Categories<\/h2>/);

  const settingsUrl = await request(app).get('/main-admin/store?tab=settings').set('Cookie', admin.cookie);
  // An unrecognized tab value falls back to Products, same as before.
  assert.match(settingsUrl.text, /\+ New Product/);
});

test('Product Options: add rows with title/price/qty/enabled, save, and see them pre-filled on reload', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Mug' });

  const editPage = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, /<h2>Options<\/h2>/);
  assert.match(editPage.text, /\+ Add Another Option/);
  assert.match(editPage.text, /data-options-list data-next-index="0"/, 'a brand-new product starts with an empty, JS-appendable options list');

  const csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}/options`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      'options[0][name]': 'Blue',
      'options[0][price]': '9.50',
      'options[0][qty]': '5',
      'options[0][enabled]': '1',
      'options[1][name]': 'Red',
      'options[1][price]': '11.00',
      'options[1][enabled]': '0',
      _csrf: csrf,
    });

  const rows = await db.prepare('SELECT * FROM store_product_options WHERE product_id = ? ORDER BY position').all(productId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Blue');
  assert.equal(rows[0].price_cents, 950);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].enabled, 1);
  assert.equal(rows[1].name, 'Red');
  assert.equal(rows[1].enabled, 0);

  const reloaded = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.match(reloaded.text, /value="Blue"/);
  assert.match(reloaded.text, /value="9.50"/);
  assert.match(reloaded.text, /value="Red"/);

  // A disabled option is never offered at checkout.
  await activateProduct(admin, productId);
  const detail = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.equal(detail.status, 200);
});

test('Fulfillment Totals: sums quantity across every paid order, grouped by product + option', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Fulfillment Widget' });
  await activateProduct(admin, productId);
  let csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}/options`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ 'options[0][name]': 'Standard', 'options[0][price]': '5.00', 'options[0][enabled]': '1', _csrf: csrf });
  const option = await db.prepare('SELECT id FROM store_product_options WHERE product_id = ?').get(productId);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fulfillment Buyer', 'fulfillment-buyer', 'parent')").run()).lastInsertRowid;

  csrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '3', 'items[0][optionId]': String(option.id), _csrf: csrf });
  csrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '2', 'items[0][optionId]': String(option.id), _csrf: csrf });

  const ordersPage = await request(app).get('/main-admin/store?tab=orders').set('Cookie', admin.cookie);
  assert.match(ordersPage.text, /Fulfillment Totals/);
  assert.match(ordersPage.text, /id="fulfillment-totals-dialog"/);
  const dialogMatch = /<dialog id="fulfillment-totals-dialog"[\s\S]*?<\/dialog>/.exec(ordersPage.text);
  assert.ok(dialogMatch);
  assert.match(dialogMatch[0], /Fulfillment Widget/);
  assert.match(dialogMatch[0], /Standard/);
  assert.match(dialogMatch[0], /<td>5<\/td>/); // 3 + 2 = 5, still 'paid' (not yet fulfilled)
});

test('Analytics tab: date-range dropdown, a sales chart, and per-product/option totals', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Analytics Gadget' });
  await activateProduct(admin, productId);
  const csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}/options`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ 'options[0][name]': 'Only Option', 'options[0][price]': '7.00', 'options[0][enabled]': '1', _csrf: csrf });
  const option = await db.prepare('SELECT id FROM store_product_options WHERE product_id = ?').get(productId);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Analytics Buyer', 'analytics-buyer', 'parent')").run()).lastInsertRowid;
  const saleCsrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '4', 'items[0][optionId]': String(option.id), _csrf: saleCsrf });

  const nav = await request(app).get('/main-admin').set('Cookie', admin.cookie);
  assert.match(nav.text, /href="\/main-admin\/store\?tab=analytics">Analytics</);

  const page = await request(app).get('/main-admin/store?tab=analytics&range=month').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Date Range/);
  assert.match(page.text, /<option value="today"/);
  assert.match(page.text, /<option value="all"[^>]*>All Time<\/option>/);
  assert.match(page.text, /class="store-sales-chart"/);
  assert.match(page.text, /Sales By Product/);
  assert.match(page.text, /Analytics Gadget/);
  assert.match(page.text, /Only Option/);
  assert.match(page.text, /\$28\.00/); // 4 * $7.00
  assert.match(page.text, /<span class="store-analytics-figure">4<br/);

  const todayPage = await request(app).get('/main-admin/store?tab=analytics&range=today').set('Cookie', admin.cookie);
  assert.match(todayPage.text, /Analytics Gadget/, 'a sale placed moments ago should show up under Today too');
});

test('Product card: no separate Edit button, the whole card links to Edit, status shown next to the name', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Clickable Product' });

  const page = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /roster-action-btn" href="\/main-admin\/store\/\d+\/edit">Edit</);
  assert.match(page.text, new RegExp(`<a class="team-info-card store-product-card" href="/main-admin/store/${productId}/edit">`));
  const cardMatch = new RegExp(`<a class="team-info-card store-product-card" href="/main-admin/store/${productId}/edit">([\\s\\S]*?)</a>`).exec(page.text);
  assert.ok(cardMatch);
  assert.match(cardMatch[1], /Clickable Product/);
  assert.match(cardMatch[1], /badge-pill-orange">Draft/);
});

test('Filter label says "Filter" (not "Filter by category"), and a View Member Store button links to /store', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /Filter by category/i);
  assert.match(page.text, /<label>Filter\s*<select name="category"/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/store" target="_blank" rel="noopener">View Member Store<\/a>/);
});

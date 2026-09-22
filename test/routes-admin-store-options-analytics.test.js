// Coverage for a real request batch on Main Admin Shop:
// - product Options as Group -> Values rows (title/price/qty/
//   enable-disable), replacing plain sizes - see
//   supabase/migrations/20261005010000_store_option_groups.sql
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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Test Family ${familyCounter}`)).lastInsertRowid;
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

test('Settings tab is gone; Add/Edit Category lives on Products, not a separate list', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/store').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /store\?tab=settings">Settings/);
  assert.match(page.text, />Add\/Edit Category</);
  // A real request: "categories isn't listed on product page. just the
  // product cards" - no standalone Categories section/heading outside
  // the popup.
  assert.doesNotMatch(page.text, /<h2>Categories<\/h2>/);

  const settingsUrl = await request(app).get('/main-admin/store?tab=settings').set('Cookie', admin.cookie);
  // An unrecognized tab value falls back to Products, same as before.
  assert.match(settingsUrl.text, /\+ New Product/);
});

test('Product Options: add a group of value rows with title/price/qty/enabled, save, and see them pre-filled on reload', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Mug' });

  const editPage = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, /<h2>Options<\/h2>/);
  assert.match(editPage.text, /\+ Add Option Group/);
  assert.match(editPage.text, /data-groups-list data-next-index="0"/, 'a brand-new product starts with an empty, JS-appendable groups list');

  // A real request: "only one save button at the bottom" merged the
  // Details and Options forms into one - options now save through the
  // same POST /:id the product's own name/price already go through, so
  // this includes both (matching whatever the product was created with).
  const csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      name: 'Mug',
      price: '10.00',
      'groups[0][name]': 'Color',
      'groups[0][values][0][name]': 'Blue',
      'groups[0][values][0][price]': '9.50',
      'groups[0][values][0][qty]': '5',
      'groups[0][values][0][enabled]': '1',
      'groups[0][values][1][name]': 'Red',
      'groups[0][values][1][price]': '11.00',
      'groups[0][values][1][enabled]': '0',
      _csrf: csrf,
    });

  const group = await db.prepare('SELECT * FROM store_product_option_groups WHERE product_id = ?').get(productId);
  assert.equal(group.name, 'Color');
  const rows = await db.prepare('SELECT * FROM store_product_options WHERE group_id = ? ORDER BY position').all(group.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Blue');
  assert.equal(rows[0].price_cents, 950);
  assert.equal(rows[0].quantity, 5);
  assert.equal(rows[0].enabled, 1);
  assert.equal(rows[1].name, 'Red');
  assert.equal(rows[1].enabled, 0);

  const reloaded = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.match(reloaded.text, /value="Color"/);
  assert.match(reloaded.text, /value="Blue"/);
  assert.match(reloaded.text, /value="9.50"/);
  assert.match(reloaded.text, /value="Red"/);

  // A disabled option is never offered at checkout.
  await activateProduct(admin, productId);
  const detail = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.equal(detail.status, 200);
});

test('a real request: "add option will be a drop down menu... sub categories to add variables, each with their own price" - multiple groups, summed pricing', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Shopify Style Shirt', price: '15.00' });
  await activateProduct(admin, productId);
  const csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      name: 'Shopify Style Shirt',
      price: '15.00',
      'groups[0][name]': 'Size',
      'groups[0][values][0][name]': 'Small',
      'groups[0][values][0][enabled]': '1',
      'groups[0][values][1][name]': 'Large',
      'groups[0][values][1][price]': '3.00',
      'groups[0][values][1][enabled]': '1',
      'groups[1][name]': 'Color',
      'groups[1][values][0][name]': 'Blue',
      'groups[1][values][0][price]': '2.00',
      'groups[1][values][0][enabled]': '1',
      _csrf: csrf,
    });

  const groups = await db.prepare('SELECT * FROM store_product_option_groups WHERE product_id = ? ORDER BY position').all(productId);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, 'Size');
  assert.equal(groups[1].name, 'Color');
  const small = await db.prepare('SELECT * FROM store_product_options WHERE group_id = ? AND name = ?').get(groups[0].id, 'Small');
  const large = await db.prepare('SELECT * FROM store_product_options WHERE group_id = ? AND name = ?').get(groups[0].id, 'Large');
  const blue = await db.prepare('SELECT * FROM store_product_options WHERE group_id = ? AND name = ?').get(groups[1].id, 'Blue');
  assert.equal(small.price_cents, null, 'a value with no price entered stays unset, not $0');
  assert.equal(large.price_cents, 300);
  assert.equal(blue.price_cents, 200);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Multi Group Buyer', 'multi-group-buyer', 'parent')").run()).lastInsertRowid;

  // Neither group's value has a price ("Small" + no color group picked
  // -> not possible, Color is required too) - picking Small + Blue should
  // total just Blue's $2.00 (Small contributes $0), never fall back to
  // the base $15.00 price, since "total the value from both if both have
  // prices" - one has a price, so that one wins.
  let orderCsrf = await freshCsrf(admin, 'orders');
  const smallBlueRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      'items[0][productId]': productId,
      'items[0][quantity]': '1',
      [`items[0][optionValues][${groups[0].id}]`]: String(small.id),
      [`items[0][optionValues][${groups[1].id}]`]: String(blue.id),
      _csrf: orderCsrf,
    });
  const smallBlueOrderId = /\/main-admin\/store\/orders\/(\d+)/.exec(smallBlueRes.headers.location)[1];
  const smallBlueItem = await db.prepare('SELECT option_name, unit_price_cents FROM store_order_items WHERE order_id = ?').get(smallBlueOrderId);
  assert.equal(smallBlueItem.option_name, 'Small, Blue');
  assert.equal(smallBlueItem.unit_price_cents, 200);

  // Picking Large + Blue should total both: $3.00 + $2.00 = $5.00.
  orderCsrf = await freshCsrf(admin, 'orders');
  const largeBlueRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      'items[0][productId]': productId,
      'items[0][quantity]': '1',
      [`items[0][optionValues][${groups[0].id}]`]: String(large.id),
      [`items[0][optionValues][${groups[1].id}]`]: String(blue.id),
      _csrf: orderCsrf,
    });
  const largeBlueOrderId = /\/main-admin\/store\/orders\/(\d+)/.exec(largeBlueRes.headers.location)[1];
  const largeBlueItem = await db.prepare('SELECT option_name, unit_price_cents FROM store_order_items WHERE order_id = ?').get(largeBlueOrderId);
  assert.equal(largeBlueItem.option_name, 'Large, Blue');
  assert.equal(largeBlueItem.unit_price_cents, 500);

  // Both groups still each require a selection - not just the priced one.
  orderCsrf = await freshCsrf(admin, 'orders');
  const missingGroupRes = await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      'items[0][productId]': productId,
      'items[0][quantity]': '1',
      [`items[0][optionValues][${groups[0].id}]`]: String(small.id),
      _csrf: orderCsrf,
    });
  assert.match(decodeURIComponent(missingGroupRes.headers.location), /Choose a Color/);

  // Parent/student portal checkout renders one dropdown per group.
  const parentAccount = await createParentAccount();
  const productPage = await request(app).get(`/store/${productId}`).set('Cookie', parentAccount.cookie);
  assert.match(productPage.text, new RegExp(`optionValues\\[${groups[0].id}\\]`));
  assert.match(productPage.text, new RegExp(`optionValues\\[${groups[1].id}\\]`));
  assert.match(productPage.text, /<label>Size\s*<select/);
  assert.match(productPage.text, /<label>Color\s*<select/);
  assert.match(productPage.text, /Large \(\+\$3\.00\)/);
});

test('a real request: "only one save button at the bottom. Upload button should be on the same row as choose file."', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'One Save Button Product' });

  const page = await request(app).get(`/main-admin/store/${productId}/edit`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  // Exactly one Save button on the whole page, tied to the Details form
  // via form="details-form" (an HTML form can't nest inside another, so
  // it can't be a normal descendant and still sit after Options/Image).
  const saveButtonMatches = page.text.match(/<button type="submit"[^>]*>Save<\/button>/g) || [];
  assert.equal(saveButtonMatches.length, 1, 'expected exactly one "Save" button');
  assert.match(saveButtonMatches[0], /form="details-form"/);
  assert.doesNotMatch(page.text, />Save Options</);

  // The Image section's Choose File input and Upload button share one
  // row (same .roster-btn-row <form> - see admin-events-builder.ejs's
  // own Event Image row, the same pattern applied here).
  const imageForm = /<form method="POST" action="\/main-admin\/store\/\d+\/image"[^]*?<\/form>/.exec(page.text);
  assert.ok(imageForm, 'expected to find the Image upload form');
  assert.match(imageForm[0], /class="roster-btn-row"/);
  assert.match(imageForm[0], /<input type="file" name="image"/);
  assert.match(imageForm[0], />Upload<\/button>/);
});

test('Fulfillment Totals: sums quantity across every paid order, grouped by product + option', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Fulfillment Widget' });
  await activateProduct(admin, productId);
  let csrf = await freshCsrf(admin);
  await request(app)
    .post(`/main-admin/store/${productId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Fulfillment Widget', price: '10.00', 'groups[0][name]': 'Options', 'groups[0][values][0][name]': 'Standard', 'groups[0][values][0][price]': '5.00', 'groups[0][values][0][enabled]': '1', _csrf: csrf });
  const group = await db.prepare('SELECT id FROM store_product_option_groups WHERE product_id = ?').get(productId);
  const option = await db.prepare('SELECT id FROM store_product_options WHERE group_id = ?').get(group.id);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fulfillment Buyer', 'fulfillment-buyer', 'parent')").run()).lastInsertRowid;

  csrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '3', [`items[0][optionValues][${group.id}]`]: String(option.id), _csrf: csrf });
  csrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '2', [`items[0][optionValues][${group.id}]`]: String(option.id), _csrf: csrf });

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
    .post(`/main-admin/store/${productId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Analytics Gadget', price: '10.00', 'groups[0][name]': 'Options', 'groups[0][values][0][name]': 'Only Option', 'groups[0][values][0][price]': '7.00', 'groups[0][values][0][enabled]': '1', _csrf: csrf });
  const group = await db.prepare('SELECT id FROM store_product_option_groups WHERE product_id = ?').get(productId);
  const option = await db.prepare('SELECT id FROM store_product_options WHERE group_id = ?').get(group.id);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Analytics Buyer', 'analytics-buyer', 'parent')").run()).lastInsertRowid;
  const saleCsrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '4', [`items[0][optionValues][${group.id}]`]: String(option.id), _csrf: saleCsrf });

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

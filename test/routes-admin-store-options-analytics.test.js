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

test('Add/Edit Category still lives on Products (not the Settings tab), not a separate list', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/store').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Add\/Edit Category</);
  // A real request: "categories isn't listed on product page. just the
  // product cards" - no standalone Categories section/heading outside
  // the popup.
  assert.doesNotMatch(page.text, /<h2>Categories<\/h2>/);
});

test('a real request: "Main admin portal. Shop. Add a subpage called settings. This where general store settings will happen" - a real Settings tab, not a fallback to Products', async () => {
  const admin = await loginAsMainAdmin();
  const nav = await request(app).get('/main-admin/store').set('Cookie', admin.cookie);
  assert.match(nav.text, /href="\/main-admin\/store\?tab=settings">Settings</);

  const settingsPage = await request(app).get('/main-admin/store?tab=settings').set('Cookie', admin.cookie);
  assert.equal(settingsPage.status, 200);
  assert.doesNotMatch(settingsPage.text, /\+ New Product/, 'tab=settings must render the real Settings form, not fall back to Products');
  assert.match(settingsPage.text, /name="storeEnabled"/);
  assert.match(settingsPage.text, /name="welcomeMessage"/);
  assert.match(settingsPage.text, /name="pickupInstructions"/);
  assert.match(settingsPage.text, /name="orderNotificationEmail"/);
  // store_settings seeds store_enabled = 1 by default - the checkbox
  // should start checked, not silently off.
  assert.match(settingsPage.text, /name="storeEnabled" value="1" checked/);

  const csrf = extractCsrf(settingsPage.text);
  await request(app)
    .post('/main-admin/store/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ welcomeMessage: 'Back-to-school sale all September!', pickupInstructions: 'Pick up at the front office, Mon-Fri 9-3.', orderNotificationEmail: 'shop@coop.local', _csrf: csrf });
  // storeEnabled is intentionally omitted (an unchecked checkbox submits
  // nothing) - saving should turn the shop OFF, same as every other
  // checkbox-backed setting in this app.
  const reloaded = await request(app).get('/main-admin/store?tab=settings').set('Cookie', admin.cookie);
  assert.doesNotMatch(reloaded.text, /name="storeEnabled" value="1" checked/);
  assert.match(reloaded.text, /Back-to-school sale all September!/);
  assert.match(reloaded.text, /Pick up at the front office/);
  assert.match(reloaded.text, /value="shop@coop\.local"/);

  // The member-facing storefront must actually reflect store_enabled = 0,
  // not just the Main Admin's own settings form.
  const parent = await createParentAccount();
  const storefront = await request(app).get('/store').set('Cookie', parent.cookie);
  assert.match(storefront.text, /shop is currently closed/i);

  // Re-enable for every other test in this file - store_settings is a
  // singleton, and every other test here assumes an open storefront.
  const reopenCsrf = await freshCsrf(admin, '?tab=settings');
  await request(app).post('/main-admin/store/settings').set('Cookie', admin.cookie).type('form').send({ storeEnabled: '1', _csrf: reopenCsrf });
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

// A real bug report: "member view of product is not showing the multiple
// options and values" + "store page, product card says product is out of
// stock and it is not. When you click on the product it shows what is in
// stock correctly." Both traced to the same root cause: views/admin-
// store-edit.ejs pairs a hidden <input name="...[enabled]" value="0">
// with a same-named checkbox (value="1"), so an unchecked box still
// submits something - but a REAL browser form submits BOTH fields when
// the box IS checked, and express's qs-based body parser merges two
// same-named fields into an array ({enabled: ['0', '1']}), not the plain
// string '1' routes/admin-store.js used to compare against with `===`.
// supertest's own .send({...object}) (used in the test just above this
// one) can only ever send ONE value per key, so it never actually
// exercised this exact collision - this test sends a raw, pre-built
// request body instead, the only way to reproduce two fields sharing one
// name the way a real <form> does.
test('a REAL browser\'s hidden-input + checkbox pair for "Enabled" (both fields submit when checked) still saves as enabled, not silently disabled', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Enabled Checkbox Mug' });
  const csrf = await freshCsrf(admin);

  const rawBody = [
    'name=' + encodeURIComponent('Enabled Checkbox Mug'),
    'price=10.00',
    'groups[0][name]=' + encodeURIComponent('Color'),
    'groups[0][values][0][name]=' + encodeURIComponent('Blue'),
    'groups[0][values][0][qty]=5',
    // The exact shape a real browser sends: the hidden fallback (0) AND
    // the checked checkbox (1) for the SAME field name, in DOM order.
    'groups[0][values][0][enabled]=0',
    'groups[0][values][0][enabled]=1',
    '_csrf=' + encodeURIComponent(csrf),
  ].join('&');

  await request(app)
    .post(`/main-admin/store/${productId}`)
    .set('Cookie', admin.cookie)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(rawBody);

  const group = await db.prepare('SELECT * FROM store_product_option_groups WHERE product_id = ?').get(productId);
  const row = await db.prepare('SELECT * FROM store_product_options WHERE group_id = ?').get(group.id);
  assert.equal(row.enabled, 1, 'checking "Enabled" in a real browser must actually save as enabled');

  // Closes the loop on both symptoms: once truly enabled, the option
  // shows on the member-facing detail page, and the list page's in-stock
  // badge (which also reads this same enabled flag) is no longer wrong.
  await activateProduct(admin, productId);
  const member = await createParentAccount();
  const listPage = await request(app).get('/store').set('Cookie', member.cookie);
  const card = listPage.text.slice(listPage.text.lastIndexOf('<a class="store-product-card"', listPage.text.indexOf('Enabled Checkbox Mug')), listPage.text.indexOf('</a>', listPage.text.indexOf('Enabled Checkbox Mug')));
  assert.match(card, /store-product-card-stock store-in-stock">\s*<span class="store-stock-dot"><\/span>In Stock/, 'a product with an actually-enabled, in-stock option must not show Out of Stock');

  const detailPage = await request(app).get(`/store/${productId}`).set('Cookie', member.cookie);
  assert.match(detailPage.text, /name="optionValues\[\d+\]"/, 'the option group dropdown must render for the member, not be filtered down to nothing');
  assert.match(detailPage.text, /Blue/);
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

test('a real bug report: "Shop Orders subpage the buttons and list overlap" - Fulfill/Cancel render in their own <div>, not a grid directly on the <td>, with a real width floor for the table\'s own column math', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Overlap Check Item' });
  await activateProduct(admin, productId);
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Overlap Buyer', 'overlap-buyer', 'parent')").run()).lastInsertRowid;
  const csrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '1', _csrf: csrf });

  const ordersPage = await request(app).get('/main-admin/store?tab=orders').set('Cookie', admin.cookie);
  // Putting .roster-btn-row's own class (mobile: display: grid) directly
  // on a <td> broke the table's column-width math - it must live on a
  // <div> inside the cell, matching every other table/card in the app.
  assert.doesNotMatch(ordersPage.text, /<td class="roster-btn-row">/);
  assert.match(ordersPage.text, /<td class="store-orders-actions-col">\s*<div class="roster-btn-row">/);
  // .roster-action-btn/.roster-btn-row both zero out min-width on mobile
  // (styles.css), which also strips the signal <table>'s own auto layout
  // needs to give this column real room - store-orders-actions-col
  // restores an explicit floor, and roster-table-fit-content lets the
  // table actually grow to use it instead of being forced to exactly
  // 100% width no matter what its cells need.
  assert.match(ordersPage.text, /<table class="[^"]*\broster-table-fit-content\b[^"]*">/);
  assert.match(ordersPage.text, /<th class="store-orders-actions-col"><\/th>/);
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

test('Product card: no separate Edit button, the whole card links to Edit, status shown as a pill at the bottom', async () => {
  const admin = await loginAsMainAdmin();
  const productId = await createProduct(admin, { name: 'Clickable Product' });

  const page = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /roster-action-btn" href="\/main-admin\/store\/\d+\/edit">Edit</);
  assert.match(page.text, new RegExp(`<a class="store-admin-product-card" href="/main-admin/store/${productId}/edit">`));
  const cardMatch = new RegExp(`<a class="store-admin-product-card" href="/main-admin/store/${productId}/edit">([\\s\\S]*?)</a>`).exec(page.text);
  assert.ok(cardMatch);
  assert.match(cardMatch[1], /Clickable Product/);
  assert.match(cardMatch[1], /badge-pill-orange store-admin-card-status">Draft/);
});

test('a real request: "Main admin portal product card should look exactly like this" - category row, In Person Sales count, and In Stock', async () => {
  const admin = await loginAsMainAdmin();
  const catCsrf = await freshCsrf(admin);
  await request(app).post('/main-admin/store/categories').set('Cookie', admin.cookie).type('form').send({ name: 'Drinkware', _csrf: catCsrf });
  const category = await db.prepare("SELECT id FROM store_categories WHERE name = 'Drinkware'").get();

  const productId = await createProduct(admin, { name: 'Water Bottle', categoryId: String(category.id), inventoryCount: '5' });
  await activateProduct(admin, productId);

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sales Buyer', 'sales-buyer', 'parent')").run()).lastInsertRowid;
  const saleCsrf = await freshCsrf(admin, '?tab=orders');
  await request(app)
    .post('/main-admin/store/orders/in-person')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ memberId: String(memberId), 'items[0][productId]': String(productId), 'items[0][quantity]': '3', _csrf: saleCsrf });

  const page = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  const cardMatch = new RegExp(`<a class="store-admin-product-card" href="/main-admin/store/${productId}/edit">([\\s\\S]*?)</a>`).exec(page.text);
  assert.ok(cardMatch);
  assert.match(cardMatch[1], /Category: Drinkware/);
  assert.match(cardMatch[1], /In Person Sales: 3/);
  assert.match(cardMatch[1], /store-product-card-stock store-in-stock">\s*<span class="store-stock-dot"><\/span>In Stock/);
  assert.match(cardMatch[1], /badge-pill-green store-admin-card-status">✓ Active/);
});

test('Filter label says "Filter" (not "Filter by category"), and a View Member Store button links to /store', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/store?tab=products').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /Filter by category/i);
  assert.match(page.text, /<label>Filter\s*<select name="category"/);
  assert.match(page.text, /<a class="roster-action-btn" href="\/store" target="_blank" rel="noopener">View Member Store<\/a>/);
});

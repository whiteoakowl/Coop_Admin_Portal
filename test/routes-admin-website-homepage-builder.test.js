// A real request: "Main admin portal. Settings gear, website. Should say
// public homepage. Here you can edit the entire homepage like you would
// on Spotify or wix. Drag and drop images and text of different size
// choices. Add buttons and links. These features will be desktop only.
// Delete description and link to announcements at bottom of page."
// Covers the new homepage_blocks builder (routes/admin-website.js,
// utils/homepage.js, views/main-admin-website.ejs) end to end: the
// Settings hub card rename, the migration's one-time seed from the old
// fixed Hero/About/Benefits fields, add/edit/delete/reorder a block, the
// desktop-only CSS gate existing in markup, the removed bottom
// announcements hint, and the public homepage rendering the same blocks
// in order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-website-homepage-builder-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-website-homepage-builder-test-uploads-${process.pid}`);
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Settings hub card is renamed to Public Homepage', async () => {
  const admin = await loginAsMainAdmin();
  const hub = await request(app).get('/main-admin/settings').set('Cookie', admin.cookie);
  assert.equal(hub.status, 200);
  assert.match(hub.text, /<h3 class="team-info-title">Public Homepage<\/h3>/);
  assert.doesNotMatch(hub.text, /<h3 class="team-info-title">Website<\/h3>/);
});

test('migration seeds starting blocks from the old fixed site_settings fields', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Public Homepage<\/h1>/);

  const blocks = await db.prepare('SELECT * FROM homepage_blocks ORDER BY position').all();
  assert.ok(blocks.length >= 8, 'expected the seeded starter blocks');
  assert.equal(blocks[0].block_type, 'text');
  assert.equal(blocks[0].text_size, 'large');
  assert.match(blocks[0].text_body, /homeschool community/);
  const buttonBlock = blocks.find((b) => b.block_type === 'button');
  assert.ok(buttonBlock, 'expected a seeded button block');
  assert.equal(buttonBlock.button_label, 'Become a Member');
});

test('the builder page has no top-of-page description and no bottom announcements link', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /Edit the public homepage's copy, announcements, and FAQs without touching code\./);
  assert.doesNotMatch(page.text, /Public homepage announcements are now posted and managed from/);
});

// A real request: "Make the homepage design features mobile friendly" -
// reverses this feature's own earlier "desktop only" restriction. The
// canvas/add-block buttons used to be wrapped in a .homepage-builder-
// desktop-only div hidden below 900px, with a "requires a desktop
// screen" fallback notice shown instead - none of that markup exists
// any more, so the canvas and its own add-block buttons just always
// render, same markup at any screen width.
test('the builder canvas and add-block buttons render unconditionally - no desktop-only gate left in markup', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /homepage-builder-desktop-only/);
  assert.doesNotMatch(page.text, /requires a desktop screen/);
  assert.match(page.text, /class="roster-btn-row homepage-builder-add-row no-print"/);
  assert.match(page.text, /data-homepage-blocks-container data-reorder-url="\/main-admin\/website\/blocks\/reorder"/);
});

test('adding, editing, reordering, and deleting a text block all work', async () => {
  const admin = await loginAsMainAdmin();

  const addRes = await request(app)
    .post('/main-admin/website/blocks')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ blockType: 'text', textBody: 'Welcome families!', textSize: 'large', _csrf: admin.csrfToken });
  assert.equal(addRes.status, 302);

  const added = await db.prepare("SELECT * FROM homepage_blocks WHERE text_body = 'Welcome families!'").get();
  assert.ok(added);
  assert.equal(added.text_size, 'large');

  const page = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.match(page.text, /Welcome families!/);

  const updateRes = await request(app)
    .post(`/main-admin/website/blocks/${added.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ textBody: 'Welcome, families!', textSize: 'small', _csrf: admin.csrfToken });
  assert.equal(updateRes.status, 302);
  const updated = await db.prepare('SELECT * FROM homepage_blocks WHERE id = ?').get(added.id);
  assert.equal(updated.text_body, 'Welcome, families!');
  assert.equal(updated.text_size, 'small');

  // Reorder: move the new block to the very front.
  const allBlocks = await db.prepare('SELECT id FROM homepage_blocks ORDER BY position').all();
  const reordered = [added.id, ...allBlocks.map((b) => b.id).filter((id) => id !== added.id)];
  const reorderRes = await request(app)
    .post('/main-admin/website/blocks/reorder')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ blockIds: reordered });
  assert.equal(reorderRes.status, 200);
  const firstAfterReorder = await db.prepare('SELECT id FROM homepage_blocks ORDER BY position LIMIT 1').get();
  assert.equal(firstAfterReorder.id, added.id);

  const deleteRes = await request(app)
    .post(`/main-admin/website/blocks/${added.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(deleteRes.status, 302);
  const afterDelete = await db.prepare('SELECT id FROM homepage_blocks WHERE id = ?').get(added.id);
  assert.equal(afterDelete, undefined);
});

test('adding a button block works and renders on the public homepage', async () => {
  const admin = await loginAsMainAdmin();
  const addRes = await request(app)
    .post('/main-admin/website/blocks')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ blockType: 'button', buttonLabel: 'See Our Classes', buttonUrl: '/classes', _csrf: admin.csrfToken });
  assert.equal(addRes.status, 302);

  const publicPage = await request(app).get('/welcome');
  assert.equal(publicPage.status, 200);
  assert.match(publicPage.text, /<a class="primary-btn" href="\/classes">See Our Classes<\/a>/);
});

test('Site Info form still saves org name, contact email, and contact phone', async () => {
  const admin = await loginAsMainAdmin();
  const saveRes = await request(app)
    .post('/main-admin/website/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ org_name: 'Test Co-op', contact_email: 'hello@test.coop', contact_phone: '555-1234', _csrf: admin.csrfToken });
  assert.equal(saveRes.status, 302);

  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  assert.equal(settings.org_name, 'Test Co-op');
  assert.equal(settings.contact_email, 'hello@test.coop');
  assert.equal(settings.contact_phone, '555-1234');

  const publicPage = await request(app).get('/welcome');
  assert.match(publicPage.text, /Test Co-op/);
  assert.match(publicPage.text, /hello@test\.coop/);
});

test('the public homepage no longer has the old fixed About Us/Why Families Join Us markup', async () => {
  const publicPage = await request(app).get('/welcome');
  assert.doesNotMatch(publicPage.text, /<h2>About Us<\/h2>/);
  assert.doesNotMatch(publicPage.text, /site-benefits-grid/);
});

// Multipart upload coverage - same local-disk fallback path (no Supabase
// Storage configured in tests) routes/admin-events.js's own image-upload
// tests already cover; csrf goes in the query string for a multipart
// form (middleware/csrfProtection.js's own comment on why).
test('adding an image block uploads the file and the public homepage renders it', async () => {
  const admin = await loginAsMainAdmin();

  const addRes = await request(app)
    .post(`/main-admin/website/blocks?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('blockType', 'image')
    .field('imageAlt', 'A cheerful co-op classroom')
    .field('imageSize', 'large')
    .attach('image', Buffer.from('fake jpeg bytes'), { filename: 'classroom.jpg', contentType: 'image/jpeg' });
  assert.equal(addRes.status, 302);
  assert.doesNotMatch(addRes.headers.location, /error=/);

  const block = await db.prepare("SELECT * FROM homepage_blocks WHERE block_type = 'image'").get();
  assert.ok(block, 'expected the new image block to exist');
  assert.ok(block.image_key, 'expected an image_key to be stored');
  assert.equal(block.image_alt, 'A cheerful co-op classroom');
  assert.equal(block.image_size, 'large');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'uploads', 'homepage', block.image_key)), 'the uploaded file should exist on local disk');

  const builderPage = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.match(builderPage.text, new RegExp(`/uploads/homepage/${block.image_key}`));

  const publicPage = await request(app).get('/welcome');
  assert.match(publicPage.text, new RegExp(`<img src="/uploads/homepage/${block.image_key}" alt="A cheerful co-op classroom" />`));
  assert.match(publicPage.text, /homepage-image-large/);

  // Deleting the block also removes the file from disk.
  const deleteRes = await request(app)
    .post(`/main-admin/website/blocks/${block.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(deleteRes.status, 302);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'uploads', 'homepage', block.image_key)), false);
});

test('an image block over the 5MB limit redirects with a friendly error, not a 500', async () => {
  const admin = await loginAsMainAdmin();
  const oversized = Buffer.alloc(6 * 1024 * 1024, 'a');
  const res = await request(app)
    .post(`/main-admin/website/blocks?_csrf=${encodeURIComponent(admin.csrfToken)}`)
    .set('Cookie', admin.cookie)
    .field('blockType', 'image')
    .attach('image', oversized, { filename: 'huge.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/main-admin\/website/);
  const notice = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(notice, /too large/i);
});

// A real request: "Should be able to edit or add menu tabs to the
// homepage." (utils/homepage.js's own listMenuItems/addMenuItem/
// updateMenuItem/deleteMenuItem/reorderMenuItems, routes/admin-
// website.js's own /menu-items routes, rendered in views/public-home.ejs's
// own header).
test('adding, editing, reordering, and deleting a menu tab all work, and it renders in the public homepage header', async () => {
  const admin = await loginAsMainAdmin();

  const publicBefore = await request(app).get('/welcome');
  assert.doesNotMatch(publicBefore.text, /site-header-menu/, 'no menu section at all with zero menu items');

  const addRes = await request(app)
    .post('/main-admin/website/menu-items')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Events', url: '/events', _csrf: admin.csrfToken });
  assert.equal(addRes.status, 302);
  const added = await db.prepare("SELECT * FROM homepage_menu_items WHERE label = 'Events'").get();
  assert.ok(added);
  assert.equal(added.url, '/events');

  const builderPage = await request(app).get('/main-admin/website').set('Cookie', admin.cookie);
  assert.match(builderPage.text, /Events/);

  const publicAfter = await request(app).get('/welcome');
  assert.match(publicAfter.text, /<nav class="site-header-menu" aria-label="Site menu">/);
  assert.match(publicAfter.text, /<a href="\/events">Events<\/a>/);

  const updateRes = await request(app)
    .post(`/main-admin/website/menu-items/${added.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Our Events', url: '/events', _csrf: admin.csrfToken });
  assert.equal(updateRes.status, 302);
  const updated = await db.prepare('SELECT * FROM homepage_menu_items WHERE id = ?').get(added.id);
  assert.equal(updated.label, 'Our Events');

  // Add a second item, then reorder so the second one comes first.
  await request(app).post('/main-admin/website/menu-items').set('Cookie', admin.cookie).type('form').send({ label: 'Classes', url: '/classes', _csrf: admin.csrfToken });
  const secondItem = await db.prepare("SELECT * FROM homepage_menu_items WHERE label = 'Classes'").get();
  const reorderRes = await request(app)
    .post('/main-admin/website/menu-items/reorder')
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ blockIds: [secondItem.id, updated.id] });
  assert.equal(reorderRes.status, 200);
  const firstAfterReorder = await db.prepare('SELECT id FROM homepage_menu_items ORDER BY position LIMIT 1').get();
  assert.equal(firstAfterReorder.id, secondItem.id);

  const deleteRes = await request(app)
    .post(`/main-admin/website/menu-items/${secondItem.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(deleteRes.status, 302);
  const afterDelete = await db.prepare('SELECT id FROM homepage_menu_items WHERE id = ?').get(secondItem.id);
  assert.equal(afterDelete, undefined);
});

test('a menu tab requires both a label and a URL', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/website/menu-items')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: '', url: '', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
});

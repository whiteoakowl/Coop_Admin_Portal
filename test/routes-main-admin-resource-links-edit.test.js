// Coverage for Main Admin > Resource Links polish (item 14) - a real
// request: "add category and add resource buttons should be the same
// row/size on mobile... 'add category' should say 'add/edit category'...
// click on the resource, a window should pop up where you can edit the
// category and info and save." Covers the two new server-side pieces
// (category rename, resource update) and the markup the popups need
// (matching button classes, per-resource data-* attributes for the
// shared Edit Resource dialog's own JS to read).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-resource-links-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-resource-links-edit-test-uploads-${process.pid}`);
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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/resource-links').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('toolbar: Add/Edit Category and Add Resource buttons share the same roster-action-btn class (same row/size on mobile)', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/resource-links').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="roster-action-btn" onclick="document\.getElementById\('add-category-dialog'\)\.showModal\(\)">\+ Add\/Edit Category</);
  assert.match(page.text, /class="roster-action-btn" onclick="document\.getElementById\('add-resource-dialog'\)\.showModal\(\)">\+ Add Resource</);
  assert.match(page.text, /<h3>Add\/Edit Category<\/h3>/);
});

test('category rename: POST /categories/:id updates the title in place', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const category = await db.prepare("INSERT INTO resource_link_categories (title, position) VALUES ('Field Trips', 0) RETURNING id").get();

  const res = await request(app)
    .post(`/main-admin/resource-links/categories/${category.id}`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Local Field Trips' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const renamed = await db.prepare('SELECT * FROM resource_link_categories WHERE id = ?').get(category.id);
  assert.equal(renamed.title, 'Local Field Trips');

  const page = await request(app).get('/main-admin/resource-links').set('Cookie', cookie);
  assert.match(page.text, new RegExp(`value="Local Field Trips"`));
  assert.match(page.text, new RegExp(`action="/main-admin/resource-links/categories/${category.id}" class="roster-btn-form"`));
});

test('resource title is a clickable button carrying the row data the Edit Resource popup needs, and POST /:id saves the edit', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const link = await db
    .prepare("INSERT INTO resource_links (title, url, description, city, state, status) VALUES ('Permission Form', 'https://example.com/form', 'Sign before trips', 'Sanford', 'FL', 'approved') RETURNING id")
    .get();

  const page = await request(app).get('/main-admin/resource-links').set('Cookie', cookie);
  assert.match(page.text, /data-edit-resource/);
  assert.match(page.text, new RegExp(`data-id="${link.id}"`));
  assert.match(page.text, /data-title="Permission Form"/);
  assert.match(page.text, /data-url="https:\/\/example\.com\/form"/);
  assert.match(page.text, /id="edit-resource-dialog"/);
  assert.match(page.text, /id="edit-resource-form"/);

  const res = await request(app)
    .post(`/main-admin/resource-links/${link.id}`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Permission Form (Updated)', url: 'https://example.com/form2', description: 'Updated note', city: 'Sanford', state: 'FL', categoryId: '' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const updated = await db.prepare('SELECT * FROM resource_links WHERE id = ?').get(link.id);
  assert.equal(updated.title, 'Permission Form (Updated)');
  assert.equal(updated.url, 'https://example.com/form2');
  assert.equal(updated.description, 'Updated note');
});

test('resource update requires a title and website, same as create', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const link = await db.prepare("INSERT INTO resource_links (title, url, status) VALUES ('Keep Me', 'https://example.com', 'approved') RETURNING id").get();

  const res = await request(app)
    .post(`/main-admin/resource-links/${link.id}`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: '', url: '' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);

  const unchanged = await db.prepare('SELECT * FROM resource_links WHERE id = ?').get(link.id);
  assert.equal(unchanged.title, 'Keep Me');
});

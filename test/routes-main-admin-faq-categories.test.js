// A real request: "main admin, settings gear, faq, question answer and
// choose category. Button with popup for add/edit category." Mirrors
// the Shop's own Add/Edit Category popup (routes/admin-store.js's POST
// /store/categories/bulk-save, views/admin-store-list.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-faq-categories-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-faq-categories-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/faq').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Add/Edit Category: adding a new category through the popup works, and shows in the FAQ form\'s dropdown', async () => {
  const admin = await loginAsMainAdmin();

  const res = await request(app)
    .post('/main-admin/faq/categories/bulk-save')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ newCategoryName: 'Scheduling', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  const category = await db.prepare("SELECT * FROM faq_categories WHERE name = 'Scheduling'").get();
  assert.ok(category);

  const page = await request(app).get('/main-admin/faq').set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`<select name="categoryId">[\\s\\S]*?<option value="${category.id}">Scheduling</option>`));
  assert.match(page.text, />Add\/Edit Category</);
});

test('renaming a category through the bulk-save form updates it', async () => {
  const admin = await loginAsMainAdmin();
  const categoryInfo = await db.prepare("INSERT INTO faq_categories (name) VALUES ('Old Name') RETURNING id").get();

  await request(app)
    .post('/main-admin/faq/categories/bulk-save')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ categoryId: String(categoryInfo.id), categoryName: 'New Name', _csrf: admin.csrfToken });

  const updated = await db.prepare('SELECT * FROM faq_categories WHERE id = ?').get(categoryInfo.id);
  assert.equal(updated.name, 'New Name');
});

test('an FAQ can be added with a category, which shows on the public FAQ list and the admin page', async () => {
  const admin = await loginAsMainAdmin();
  const categoryInfo = await db.prepare("INSERT INTO faq_categories (name) VALUES ('Membership') RETURNING id").get();

  const res = await request(app)
    .post('/main-admin/faq/add')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ question: 'How do I join?', answer: 'Fill out the application.', categoryId: String(categoryInfo.id), _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  const faq = await db.prepare('SELECT * FROM faqs WHERE question = ?').get('How do I join?');
  assert.equal(faq.category_id, categoryInfo.id);

  const page = await request(app).get('/main-admin/faq').set('Cookie', admin.cookie);
  assert.match(page.text, /How do I join\?[\s\S]*?Membership/);
});

test('an FAQ can be added with no category (stays optional)', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/faq/add')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ question: 'No category question?', answer: 'An answer.', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  const faq = await db.prepare('SELECT * FROM faqs WHERE question = ?').get('No category question?');
  assert.equal(faq.category_id, null);
});

test('deleting a category leaves its FAQs uncategorized, not deleted', async () => {
  const admin = await loginAsMainAdmin();
  const categoryInfo = await db.prepare("INSERT INTO faq_categories (name) VALUES ('Temp Category') RETURNING id").get();
  const faqInfo = await db.prepare('INSERT INTO faqs (question, answer, category_id) VALUES (?, ?, ?) RETURNING id').get('Temp question?', 'Temp answer.', categoryInfo.id);

  const res = await request(app)
    .post(`/main-admin/faq/categories/${categoryInfo.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 302);

  const category = await db.prepare('SELECT * FROM faq_categories WHERE id = ?').get(categoryInfo.id);
  assert.equal(category, undefined);
  const faq = await db.prepare('SELECT * FROM faqs WHERE id = ?').get(faqInfo.id);
  assert.ok(faq, 'the FAQ itself should still exist');
  assert.equal(faq.category_id, null);
});

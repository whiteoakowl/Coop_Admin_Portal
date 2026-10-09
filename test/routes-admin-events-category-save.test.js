// A real bug report: "Events, choosing a category in the dropdown menu
// and click save. It doesn't save." The Details tab's Category <select
// name="categoryId"> (views/admin-events-builder.ejs) always posted to
// POST /main-admin/events/:id (routes/admin-events.js), but that route
// never read req.body.categoryId at all - it only spread the event's
// existing categoryId through unchanged via eventDataFromRow(event), so
// picking a new category and saving silently kept the old one forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-events-category-save-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-events-category-save-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');

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

test('Details tab: picking a Category and clicking Save actually saves it', async () => {
  const admin = await loginAsMainAdmin();

  const catRes = await request(app)
    .post('/main-admin/events/categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Field Trips', _csrf: admin.csrfToken });
  assert.equal(catRes.status, 302);

  const categories = await (require('../utils/events').listCategories)();
  const category = categories.find((c) => c.name === 'Field Trips');
  assert.ok(category, 'expected the new category to exist');

  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Category Save Test Event', startsAt: '2026-10-15T18:00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location)[1]);

  const builderPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.doesNotMatch(builderPage.text, new RegExp(`value="${category.id}" selected`), 'category should not be pre-selected yet');

  const saveRes = await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      title: 'Category Save Test Event',
      startsAt: '2026-10-15T18:00',
      categoryId: String(category.id),
      _csrf: admin.csrfToken,
    });
  assert.equal(saveRes.status, 302);
  assert.match(saveRes.headers.location, /notice=/);

  const afterSave = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(afterSave.text, new RegExp(`<option value="${category.id}" selected>Field Trips</option>`), 'the saved category should now be selected on reload');

  const event = await (require('../utils/events').getEvent)(eventId);
  assert.equal(event.category_id, category.id);
});

// A real request: "main admin, settings, faq should be it's own tab under
// settings, not under website tab." FAQ used to be a section on the
// bottom of the Website settings page (routes/main-admin.js's old
// /website/faqs, /website/faqs/:id/delete) - now its own tab/route
// (/main-admin/faq, /main-admin/faq/add, /main-admin/faq/:id/delete),
// same underlying faqs table/data, unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-faq-tab-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-faq-tab-test-uploads-${process.pid}`);
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
  const loginRes = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123', next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/faq').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('FAQ has its own Settings tab, separate from Website', async () => {
  const { cookie } = await loginAsMainAdmin();

  const settingsTabs = await request(app).get('/main-admin/faq').set('Cookie', cookie);
  assert.equal(settingsTabs.status, 200);
  assert.match(settingsTabs.text, /<a class="view-tab active" href="\/main-admin\/faq">FAQ<\/a>/);

  const websitePage = await request(app).get('/main-admin/website').set('Cookie', cookie);
  assert.equal(websitePage.status, 200);
  assert.doesNotMatch(websitePage.text, />FAQs</, 'FAQ section should no longer render on the Website page');
  assert.match(websitePage.text, /<a class="view-tab" href="\/main-admin\/faq">FAQ<\/a>/, 'the Website page still offers the FAQ tab to switch to');
});

test('adding and deleting an FAQ works through the new /main-admin/faq routes', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  const addRes = await request(app)
    .post('/main-admin/faq/add')
    .set('Cookie', cookie)
    .type('form')
    .send({ question: 'What time do we meet?', answer: '9am on Mondays and Wednesdays.', _csrf: csrfToken });
  assert.equal(addRes.status, 302);
  assert.match(addRes.headers.location, /\/main-admin\/faq/);

  const faqPage = await request(app).get('/main-admin/faq').set('Cookie', cookie);
  assert.match(faqPage.text, /What time do we meet\?/);

  const faq = await db.prepare('SELECT id FROM faqs WHERE question = ?').get('What time do we meet?');
  const deleteRes = await request(app)
    .post(`/main-admin/faq/${faq.id}/delete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(deleteRes.status, 302);

  const afterDelete = await db.prepare('SELECT id FROM faqs WHERE id = ?').get(faq.id);
  assert.equal(afterDelete, undefined);
});

// A real request: "no description on Facebook and website settings
// pages." The Website page's own intro sentence is gone - just the
// heading, the live-site link, and each section's own form now.
test('the Website page has no top-of-page description', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/website').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Edit the public homepage's copy, announcements, and FAQs without touching code\./);
});

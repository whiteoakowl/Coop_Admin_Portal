// Coverage for admin-defined extra membership-form questions (a real
// request: "under members in main admin portal there should be a
// settings tab for editing and adding parts of the membership form") -
// utils/membershipFormFields.js, the Main Admin Settings tab CRUD
// (routes/main-admin-members.js's /settings/membership-fields*), and
// that the answers actually get collected and saved through both the
// admin-entered Membership Form (routes/membership.js) and the public
// self-registration application (routes/portal-auth.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `membership-form-fields-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `membership-form-fields-test-uploads-${process.pid}`);
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
const membershipFormFields = require('../utils/membershipFormFields');

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
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/membership').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('POST /main-admin/members/settings/membership-fields adds a field, shown on Settings and the Membership Form', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/settings/membership-fields')
    .set('Cookie', cookie)
    .type('form')
    .send({ target: 'parent', label: 'T-Shirt Size', fieldType: 'dropdown', options: 'Small\nMedium\nLarge', isRequired: '1', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const settingsPage = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.match(settingsPage.text, /T-Shirt Size/);
  assert.match(settingsPage.text, /Medium/);

  const { cookie: coopCookie } = await loginAsCoopAdmin();
  const membershipFormPage = await request(app).get('/membership').set('Cookie', coopCookie);
  assert.match(membershipFormPage.text, /T-Shirt Size/);
});

test('a submitted custom field answer is saved against the new parent member', async () => {
  const fields = await membershipFormFields.listFields('parent');
  const sizeField = fields.find((f) => f.label === 'T-Shirt Size');
  assert.ok(sizeField, 'expected the field created in the previous test to still exist');

  const { cookie, csrfToken } = await loginAsCoopAdmin();
  const res = await request(app)
    .post('/membership')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'CustomFieldFamily',
      'parents[0][name]': 'Custom Field Parent',
      [`parents[0][customFields][f${sizeField.id}]`]: 'Large',
      'children[0][name]': 'Custom Field Kid',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const parent = await db.prepare("SELECT id FROM members WHERE name = 'Custom Field Parent'").get();
  assert.ok(parent);
  const values = await membershipFormFields.valuesForMember(parent.id);
  assert.equal(values[sizeField.id], 'Large');
});

test('POST /settings/membership-fields/:id/update edits the field in place', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const fields = await membershipFormFields.listFields('parent');
  const sizeField = fields.find((f) => f.label === 'T-Shirt Size');

  const res = await request(app)
    .post(`/main-admin/members/settings/membership-fields/${sizeField.id}/update`)
    .set('Cookie', cookie)
    .type('form')
    .send({ label: 'Shirt Size', fieldType: 'dropdown', options: 'Small\nMedium\nLarge\nXL', isRequired: '', _csrf: csrfToken });
  assert.equal(res.status, 302);

  const updated = await membershipFormFields.getField(sizeField.id);
  assert.equal(updated.label, 'Shirt Size');
  assert.deepEqual(updated.options, ['Small', 'Medium', 'Large', 'XL']);
  assert.equal(Number(updated.is_required), 0);
});

test('POST /settings/membership-fields/:id/delete removes the field and its stored answers', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const fields = await membershipFormFields.listFields('parent');
  const sizeField = fields.find((f) => f.label === 'Shirt Size');

  const res = await request(app)
    .post(`/main-admin/members/settings/membership-fields/${sizeField.id}/delete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(res.status, 302);

  const stillThere = await membershipFormFields.getField(sizeField.id);
  assert.equal(stillThere, null);
  const valueCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM membership_form_field_values WHERE field_id = ?').get(sizeField.id)).c);
  assert.equal(valueCount, 0);
});

test('a self-registered parent through /register saves a submitted custom field answer', async () => {
  const id = await membershipFormFields.createField('parent', 'How did you hear about us?', 'short_text', null, false);

  const res = await request(app)
    .post('/register')
    .type('form')
    .send({
      firstName: 'Custom',
      lastName: 'Registrant',
      email: 'custom.registrant@example.com',
      password: 'testpassword123',
      confirmPassword: 'testpassword123',
      handbookRead: '1',
      [`customFields[f${id}]`]: 'Word of mouth',
    });
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const parent = await db.prepare("SELECT id FROM members WHERE LOWER(email) = 'custom.registrant@example.com'").get();
  assert.ok(parent);
  const values = await membershipFormFields.valuesForMember(parent.id);
  assert.equal(values[id], 'Word of mouth');
});

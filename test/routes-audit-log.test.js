// Route-level coverage for the Audit Log (Community & Commerce track,
// item 13). See utils/auditLog.js's own comment: record() is called
// directly from admin route handlers right after the real action
// already succeeded - these tests exercise that thread across several
// different features (financial changes, deletions, an admin settings
// change), not just the log's own CRUD.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `audit-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `audit-log-test-uploads-${process.pid}`);
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
const auditLog = require('../utils/auditLog');

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

let memberCounter = 0;
async function createMember() {
  memberCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Audit Family ${memberCounter}`)).lastInsertRowid;
  const code = `AUDIT${memberCounter}`;
  const info = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Audit Student ${memberCounter}`, code, code, familyId);
  return info.lastInsertRowid;
}

test('audit log requires sign-in', async () => {
  const res = await request(app).get('/main-admin/audit-log');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('recording a payment and a refund each create a real audit entry', async () => {
  const admin = await loginAsMainAdmin();
  const memberId = await createMember();
  await request(app)
    .post(`/main-admin/accounting/members/${memberId}/charges`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ description: 'Field trip fee', amount: '20.00', _csrf: admin.csrfToken });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(memberId);

  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ amount: '20.00', direction: 'payment', note: 'Cash', _csrf: admin.csrfToken });

  let entries = await auditLog.list({ targetType: 'payment_charge' });
  assert.ok(entries.some((e) => e.action === 'payment_recorded' && e.target_id === charge.id));

  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ amount: '20.00', direction: 'refund', note: 'Trip cancelled', _csrf: admin.csrfToken });

  entries = await auditLog.list({ targetType: 'payment_charge' });
  assert.ok(entries.some((e) => e.action === 'refund_recorded' && e.target_id === charge.id));

  await request(app).post(`/main-admin/accounting/charges/${charge.id}/cancel`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  entries = await auditLog.list({ targetType: 'payment_charge' });
  assert.ok(entries.some((e) => e.action === 'charge_cancelled' && e.target_id === charge.id));
});

test('deleting a store product creates an audit entry with the product name', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/store').set('Cookie', admin.cookie).type('form').send({ name: 'Audit Test Shirt', price: '10.00', availability: 'both', _csrf: admin.csrfToken });
  const productId = /\/main-admin\/store\/(\d+)\/edit/.exec(createRes.headers.location)[1];

  await request(app).post(`/main-admin/store/${productId}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const entries = await auditLog.list({ targetType: 'store_product' });
  const entry = entries.find((e) => e.target_id === Number(productId));
  assert.ok(entry);
  assert.equal(entry.action, 'product_deleted');
  assert.equal(entry.detail, 'Audit Test Shirt');
  assert.equal(entry.actor_email, process.env.MAIN_ADMIN_EMAIL);
});

test('deleting a newsletter issue creates an audit entry', async () => {
  const admin = await loginAsMainAdmin();
  const createRes = await request(app).post('/main-admin/newsletter').set('Cookie', admin.cookie).type('form').send({ subject: 'Audit Test Issue', _csrf: admin.csrfToken });
  const issueId = /\/main-admin\/newsletter\/(\d+)\/edit/.exec(createRes.headers.location)[1];

  await request(app).post(`/main-admin/newsletter/${issueId}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const entries = await auditLog.list({ targetType: 'newsletter_issue' });
  const entry = entries.find((e) => e.target_id === Number(issueId));
  assert.ok(entry);
  assert.equal(entry.action, 'newsletter_issue_deleted');
  assert.equal(entry.detail, 'Audit Test Issue');
});

test("toggling a notification type's auto-send creates an audit entry, not a fake one", async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/notifications/event_registration/auto-send').set('Cookie', admin.cookie).type('form').send({ enabled: '0', _csrf: admin.csrfToken });

  const entries = await auditLog.list({ targetType: 'notification_type' });
  assert.ok(entries.some((e) => e.action === 'notification_auto_send_toggled' && e.detail === 'event_registration: off'));

  // Restore for any later test relying on default auto-send behavior.
  await request(app).post('/main-admin/notifications/event_registration/auto-send').set('Cookie', admin.cookie).type('form').send({ enabled: '1', _csrf: admin.csrfToken });
});

test('the audit log page filters by target type', async () => {
  const admin = await loginAsMainAdmin();
  const all = await request(app).get('/main-admin/audit-log').set('Cookie', admin.cookie);
  assert.equal(all.status, 200);
  assert.match(all.text, /payment_recorded|product_deleted/);

  const filtered = await request(app).get('/main-admin/audit-log?targetType=store_product').set('Cookie', admin.cookie);
  assert.equal(filtered.status, 200);
  assert.doesNotMatch(filtered.text, /payment_recorded/);
});

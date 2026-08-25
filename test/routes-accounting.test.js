// Route-level coverage for the Accounting/Payments foundation
// (Community & Commerce track, item 9). See utils/payments.js's own
// comments and supabase/migrations/20260825080000_payments_foundation.sql
// for the design this exercises: a payment ABSTRACTION with no real
// processor - every payment/refund is an admin recording something that
// already happened outside the app, and a charge's own status is always
// recomputed from its real payment rows, never set directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `accounting-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `accounting-test-uploads-${process.pid}`);
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
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const payments = require('../utils/payments');

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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
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

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/accounting' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/accounting').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

test('accounting requires sign-in', async () => {
  const res = await request(app).get('/accounting');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('a new charge is pending until fully paid, then flips to paid, and the member sees it in their own Accounting page', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();

  await request(app)
    .post(`/main-admin/accounting/members/${parent.memberId}/charges`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ description: 'Registration Fee', amount: '50.00', _csrf: admin.csrfToken });

  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(parent.memberId);
  assert.equal(charge.status, 'pending');
  assert.equal(charge.amount_cents, 5000);

  const balanceBefore = await payments.balanceForMember(parent.memberId);
  assert.equal(balanceBefore, 5000);

  await request(app)
    .post(`/main-admin/accounting/charges/${charge.id}/payments`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ direction: 'payment', amount: '50.00', note: 'Cash', _csrf: admin.csrfToken });

  const afterPay = await db.prepare('SELECT status FROM payment_charges WHERE id = ?').get(charge.id);
  assert.equal(afterPay.status, 'paid');
  assert.equal(await payments.balanceForMember(parent.memberId), 0);

  const memberView = await request(app).get('/accounting').set('Cookie', parent.cookie);
  assert.match(memberView.text, /Registration Fee/);
  assert.match(memberView.text, /Paid in full/);
});

// A full refund closes the charge out (status 'refunded') rather than
// re-billing the member for the same amount - the refund itself is the
// resolution (visible in receipt history), not a reason to show a
// balance due again.
test('a refund after full payment flips a charge to refunded without re-billing the balance', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  await request(app)
    .post(`/main-admin/accounting/members/${parent.memberId}/charges`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ description: 'Field Trip', amount: '20.00', _csrf: admin.csrfToken });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(parent.memberId);

  await request(app).post(`/main-admin/accounting/charges/${charge.id}/payments`).set('Cookie', admin.cookie).type('form').send({ direction: 'payment', amount: '20.00', _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/accounting/charges/${charge.id}/payments`).set('Cookie', admin.cookie).type('form').send({ direction: 'refund', amount: '20.00', note: 'Trip cancelled', _csrf: admin.csrfToken });

  const after = await db.prepare('SELECT status FROM payment_charges WHERE id = ?').get(charge.id);
  assert.equal(after.status, 'refunded');
  assert.equal(await payments.balanceForMember(parent.memberId), 0);
});

test('a cancelled charge no longer counts toward balance and its status never changes back', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  await request(app)
    .post(`/main-admin/accounting/members/${parent.memberId}/charges`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ description: 'Optional Add-on', amount: '15.00', _csrf: admin.csrfToken });
  const charge = await db.prepare('SELECT * FROM payment_charges WHERE member_id = ?').get(parent.memberId);

  await request(app).post(`/main-admin/accounting/charges/${charge.id}/cancel`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(await payments.balanceForMember(parent.memberId), 0);

  // Even if a stray payment somehow got recorded after cancellation, the
  // charge itself must stay cancelled - recalculateStatus explicitly
  // refuses to touch a cancelled charge.
  const adminAccount = await db.prepare("SELECT id FROM member_accounts WHERE email = ?").get(process.env.MAIN_ADMIN_EMAIL);
  await payments.recordPayment(charge.id, 1500, 'manual', adminAccount.id, 'late payment attempt');
  const after = await db.prepare('SELECT status FROM payment_charges WHERE id = ?').get(charge.id);
  assert.equal(after.status, 'cancelled');
});

test('an account only ever sees its own family\'s charges, not another family\'s', async () => {
  const admin = await loginAsMainAdmin();
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();
  await request(app)
    .post(`/main-admin/accounting/members/${parentA.memberId}/charges`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ description: 'Family A Only Charge', amount: '10.00', _csrf: admin.csrfToken });

  const viewB = await request(app).get('/accounting').set('Cookie', parentB.cookie);
  assert.doesNotMatch(viewB.text, /Family A Only Charge/);

  const viewA = await request(app).get('/accounting').set('Cookie', parentA.cookie);
  assert.match(viewA.text, /Family A Only Charge/);
});

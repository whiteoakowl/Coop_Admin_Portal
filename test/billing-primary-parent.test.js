// A real request: "primary parent is the only member listed on all
// account pages. Only primary parent is billed for all event signups and
// class registrations for the entire family." Covers the new
// utils/members.js primaryParentForBilling resolution directly, plus the
// two real charge-creation call sites that now use it (class
// registration and event registration), and the Accounting Accounts
// page's own member list now being filtered down to just the resolved
// billed-to members.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `billing-primary-parent-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `billing-primary-parent-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { primaryParentForBilling, generateMemberCode } = require('../utils/members');
const { createClass } = require('../utils/classSchedule');
const { registerForClass } = require('../utils/classRegistration');
const { hashPassword } = require('../utils/portalAuth');

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
// Builds a family of { primaryParent (is_primary_parent flag per
// `markPrimary`), secondaryParent, child } all sharing one family_id, so
// each test can control exactly who's marked primary.
async function makeFamily({ markPrimary = true } = {}) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Billing Family ${familyCounter}`)).id;
  const primaryCode = await generateMemberCode();
  const primaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, ?, 1) RETURNING id")
      .get(`Zachary Primary ${familyCounter}`, `billing-primary-${familyCounter}`, primaryCode, familyId, markPrimary ? 1 : 0)
  ).id;
  const secondaryCode = await generateMemberCode();
  const secondaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 0, 1) RETURNING id")
      .get(`Aaron Secondary ${familyCounter}`, `billing-secondary-${familyCounter}`, secondaryCode, familyId)
  ).id;
  const childCode = await generateMemberCode();
  const childId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
      .get(`Billing Child ${familyCounter}`, `billing-child-${familyCounter}`, childCode, familyId)
  ).id;
  const email = `billing-parent${familyCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(primaryParentId, email, hashPassword('testpassword123'))
  ).id;
  return { familyId, primaryParentId, secondaryParentId, childId, accountId };
}

test('primaryParentForBilling resolves to the family member explicitly flagged is_primary_parent', async () => {
  const { primaryParentId, secondaryParentId, childId } = await makeFamily({ markPrimary: true });
  assert.equal(await primaryParentForBilling(childId), primaryParentId);
  assert.equal(await primaryParentForBilling(secondaryParentId), primaryParentId);
  // The primary parent themselves resolves to their own id too.
  assert.equal(await primaryParentForBilling(primaryParentId), primaryParentId);
});

test('primaryParentForBilling falls back to the alphabetically-first parent/admin when nobody in the family is flagged primary', async () => {
  const { primaryParentId, secondaryParentId, childId } = await makeFamily({ markPrimary: false });
  // Neither parent is flagged - "Aaron Secondary" sorts before "Zachary
  // Primary" by last name, so the fallback should land on the secondary
  // parent here, not whichever row happens to be inserted first.
  assert.equal(await primaryParentForBilling(childId), secondaryParentId);
  assert.equal(await primaryParentForBilling(primaryParentId), secondaryParentId);
});

test('primaryParentForBilling returns the member themselves when they have no family at all', async () => {
  const code = await generateMemberCode();
  const soloId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1) RETURNING id").get('Solo Member', 'billing-solo', code)
  ).id;
  assert.equal(await primaryParentForBilling(soloId), soloId);
});

test('a child registering for a priced class is never the one billed - the charge lands on the family\'s primary parent', async () => {
  const { primaryParentId, childId, accountId } = await makeFamily({ markPrimary: true });
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Billing Test Class', priceCents: 4500, pricePer: 'students' });

  const result = await registerForClass({ classId, studentId: childId, accountId, portalRoles: ['parent'], registrantType: 'parent' });
  assert.ok(result.ok, result.error);

  const registration = await db.prepare('SELECT charge_id FROM class_registrations WHERE class_id = ? AND student_id = ?').get(classId, childId);
  assert.ok(registration.charge_id, 'expected a charge to have been created');
  const charge = await db.prepare('SELECT member_id, amount_cents FROM payment_charges WHERE id = ?').get(registration.charge_id);
  assert.equal(charge.member_id, primaryParentId, 'the charge should be billed to the primary parent, not the enrolled child');
  assert.equal(Number(charge.amount_cents), 4500);
});

test('registering for an event bills the primary parent even when a different family member registers', async () => {
  const admin = await loginAsMainAdmin();
  const { primaryParentId, childId, accountId } = await makeFamily({ markPrimary: true });

  const createRes = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Billing Test Event', startsAt: '2027-09-01T18:00', priceDollars: '15.00', _csrf: admin.csrfToken });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(createRes.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const loginRes = await request(app).post('/login').type('form').send({ email: `billing-parent${familyCounter}@example.com`, password: 'testpassword123', next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get(`/events/${eventId}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  // The CHILD registers for the event (not the primary parent).
  const registered = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(childId), _csrf: csrfToken });
  assert.match(registered.headers.location, /notice=/, registered.headers.location);

  const registration = await db.prepare('SELECT charge_id FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, childId);
  assert.ok(registration.charge_id, 'expected a charge to have been created');
  const charge = await db.prepare('SELECT member_id, amount_cents FROM payment_charges WHERE id = ?').get(registration.charge_id);
  assert.equal(charge.member_id, primaryParentId, 'the charge should be billed to the primary parent, not the registering child');
  assert.equal(Number(charge.amount_cents), 1500);
  void accountId;
});

test('the member-facing /accounting page shows the family\'s primary parent account, even when a secondary parent is logged in', async () => {
  const { primaryParentId, secondaryParentId } = await makeFamily({ markPrimary: true });
  await db
    .prepare("INSERT INTO payment_charges (member_id, account_id, source_type, source_id, description, amount_cents) VALUES (?, NULL, 'manual', NULL, 'Shared Family Charge', 3000)")
    .run(primaryParentId);

  const secondaryEmail = `billing-secondary${familyCounter}@example.com`;
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(secondaryParentId, secondaryEmail, hashPassword('testpassword123'));
  const loginRes = await request(app).post('/login').type('form').send({ email: secondaryEmail, password: 'testpassword123', next: '/accounting' });
  const cookie = loginRes.headers['set-cookie'];

  const page = await request(app).get('/accounting').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Shared Family Charge/, 'the secondary parent should see the family\'s shared account, billed to the primary parent');
});

test('Accounting Accounts page lists only resolved billable members - a secondary parent or child never gets their own row', async () => {
  const admin = await loginAsMainAdmin();
  const { primaryParentId, secondaryParentId, childId } = await makeFamily({ markPrimary: true });
  const primary = await db.prepare('SELECT name FROM members WHERE id = ?').get(primaryParentId);
  const secondary = await db.prepare('SELECT name FROM members WHERE id = ?').get(secondaryParentId);
  const child = await db.prepare('SELECT name FROM members WHERE id = ?').get(childId);

  const page = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(primary.name));
  assert.doesNotMatch(page.text, new RegExp(secondary.name), 'a non-primary parent should not get their own Accounts row');
  assert.doesNotMatch(page.text, new RegExp(child.name), 'a child should not get their own Accounts row');
});

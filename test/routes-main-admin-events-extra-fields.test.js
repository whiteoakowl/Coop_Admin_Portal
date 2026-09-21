// A real request: "volunteers, food, donations and extra fields tabs
// should be under one tab called, Volunteers. There will then be a pill
// toggle on this page for volunteers, food, donations and extra fields.
// Extra fields is where you can add extra form type questions for people
// signing up for an event." Covers the admin-side CRUD (Volunteers tab's
// Extra Fields pill) and the public registration-form side (a required
// text field must be answered to register, and the answer is recorded).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-extra-fields-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-extra-fields-test-uploads-${process.pid}`);
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

async function createPublishedEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Extra Fields Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  await request(app)
    .post(`/main-admin/events/${eventId}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

// Mirrors test/routes-events.test.js's own createParentAccount helper - a
// real parent portal account with a family, shaped the way Main Admin
// approval actually leaves the data rather than going through the full
// self-registration flow this file isn't testing.
let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Extra Fields Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const email = `extrafieldsparent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie, memberId: parentInfo.lastInsertRowid };
}

test('Extra Fields pill: add a field from the Volunteers tab, it shows in the list, and delete removes it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createPublishedEvent(admin);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Extra Fields \(0\)/);
  assert.match(page.text, /No extra fields yet/);

  const csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'T-shirt size', fieldType: 'select', options: 'Small\nMedium\nLarge', required: '1', _csrf: csrf });

  const field = await db.prepare("SELECT * FROM event_extra_fields WHERE event_id = ? AND label = 'T-shirt size'").get(eventId);
  assert.ok(field);
  assert.equal(field.field_type, 'select');
  assert.equal(field.required, 1);

  const afterAdd = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie);
  assert.match(afterAdd.text, /Extra Fields \(1\)/);
  assert.match(afterAdd.text, /T-shirt size/);
  assert.match(afterAdd.text, /select.*required/);

  const csrf2 = extractCsrf(afterAdd.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields/${field.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf2 });

  const afterDelete = await db.prepare('SELECT * FROM event_extra_fields WHERE id = ?').get(field.id);
  assert.equal(afterDelete, undefined);
});

test('Public registration: a required extra field must be answered, and the answer is recorded', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createPublishedEvent(admin);

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Emergency contact', fieldType: 'text', required: '1', _csrf: csrf });
  const field = await db.prepare("SELECT * FROM event_extra_fields WHERE event_id = ? AND label = 'Emergency contact'").get(eventId);

  const parent = await createParentAccount();
  const registerMemberId = parent.memberId;

  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.text, /Emergency contact/);
  const detailCsrf = extractCsrf(detailPage.text);

  // Missing the required answer -> rejected with an error, not registered.
  const missingRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: registerMemberId, _csrf: detailCsrf });
  assert.match(missingRes.headers.location, /error=/);
  const notRegistered = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, registerMemberId);
  assert.equal(notRegistered, undefined);

  // Answering it registers the member and records the answer.
  await request(app)
    .post(`/events/${eventId}/register`)
    .type('form')
    .set('Cookie', parent.cookie)
    .send(`memberId=${registerMemberId}&_csrf=${encodeURIComponent(detailCsrf)}&answers[f${field.id}]=${encodeURIComponent('555-1234')}`);

  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, registerMemberId);
  assert.ok(registration, 'the member should now be registered');
  const answer = await db.prepare('SELECT * FROM event_registration_answers WHERE registration_id = ? AND extra_field_id = ?').get(registration.id, field.id);
  assert.ok(answer);
  assert.equal(answer.value, '555-1234');
});

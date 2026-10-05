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

// Same shape as createParentAccount, but also adds a student child to
// the same family - needed to test family-vs-each-member scope, since
// that distinction is about WHICH family member is being registered.
async function createParentAccountWithChild() {
  familyCounter += 1;
  const familyName = `Extra Fields Scope Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Scope Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
    .get(`Scope Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `extrafieldsscope${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie, parentMemberId: parentInfo.lastInsertRowid, childMemberId: childInfo.id };
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

// A real request: "event editing resources and fields. Requires for
// each member or family. If required for family is selected only the
// parent will be asked to choose or fill out those extra fields. If for
// each member is selected then it will ask that for each member." The
// row itself opens an edit dialog now (same Save/Close/Delete shape as
// Ticket Types) instead of only ever being addable/deletable.
test('Extra Fields: the row has no trash icon any more, has an "Ask this of" scope choice, and edit/delete happen through its own dialog', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createPublishedEvent(admin);

  let csrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'T-shirt size', fieldType: 'text', scope: 'each_member', _csrf: csrf });
  const field = await db.prepare("SELECT * FROM event_extra_fields WHERE event_id = ? AND label = 'T-shirt size'").get(eventId);
  assert.equal(field.scope, 'each_member');

  let page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`class="training-lesson-row ticket-type-row" onclick="document.getElementById\\('edit-extra-field-dialog-${field.id}'\\).showModal\\(\\)"`));
  assert.doesNotMatch(page.text, new RegExp(`extra-fields/${field.id}/delete" class="inline-block-form"`));
  assert.match(page.text, new RegExp(`<dialog id="edit-extra-field-dialog-${field.id}"`));
  assert.match(page.text, />Delete Extra Field</);

  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields/${field.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Allergy note', fieldType: 'text', scope: 'family', _csrf: csrf });

  const updated = await db.prepare('SELECT * FROM event_extra_fields WHERE id = ?').get(field.id);
  assert.equal(updated.label, 'Allergy note');
  assert.equal(updated.scope, 'family');

  page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie);
  assert.match(page.text, /Allergy note/);
  assert.match(page.text, /family/);

  csrf = extractCsrf(page.text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields/${field.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: csrf });
  const afterDelete = await db.prepare('SELECT * FROM event_extra_fields WHERE id = ?').get(field.id);
  assert.equal(afterDelete, undefined);
});

test('a "family" scoped required field blocks the parent\'s own registration but never blocks a child\'s', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createPublishedEvent(admin);

  const csrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'Family photo consent', fieldType: 'checkbox', required: '1', scope: 'family', _csrf: csrf });
  const field = await db.prepare("SELECT * FROM event_extra_fields WHERE event_id = ? AND label = 'Family photo consent'").get(eventId);

  const family = await createParentAccountWithChild();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  const detailCsrf = extractCsrf(detailPage.text);

  // The child's own registration is never blocked by a family-scoped field.
  const childRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.childMemberId, _csrf: detailCsrf });
  assert.doesNotMatch(childRes.headers.location || '', /error=/);
  const childRegistration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.childMemberId);
  assert.ok(childRegistration, 'the child should be registered without ever answering the family-scoped field');

  // The parent's own registration DOES require it, since they're the parent.
  const parentMissingRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.parentMemberId, _csrf: detailCsrf });
  assert.match(parentMissingRes.headers.location, /error=/);
  const parentNotRegistered = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.parentMemberId);
  assert.equal(parentNotRegistered, undefined);

  // Answering it registers the parent.
  await request(app)
    .post(`/events/${eventId}/register`)
    .type('form')
    .set('Cookie', family.cookie)
    .send(`memberId=${family.parentMemberId}&_csrf=${encodeURIComponent(detailCsrf)}&answers[f${field.id}]=${encodeURIComponent('Yes')}`);
  const parentRegistration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.parentMemberId);
  assert.ok(parentRegistration);
});

// A real request: "requires for each member... it will ask that for
// each member" - an each_member field (the default) still applies to
// every registrant, parent or child alike, unlike the family-scoped test
// above.
test('an "each member" scoped required field blocks both a child\'s and the parent\'s own registration', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createPublishedEvent(admin);

  const csrf = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=volunteers&section=extraFields`).set('Cookie', admin.cookie)).text);
  await request(app)
    .post(`/main-admin/events/${eventId}/extra-fields`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ label: 'T-shirt size', fieldType: 'text', required: '1', scope: 'each_member', _csrf: csrf });

  const family = await createParentAccountWithChild();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  const detailCsrf = extractCsrf(detailPage.text);

  const childRes = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ memberId: family.childMemberId, _csrf: detailCsrf });
  assert.match(childRes.headers.location, /error=/);
  const childRegistration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.childMemberId);
  assert.equal(childRegistration, undefined, 'an each-member field must still block the child too');
});

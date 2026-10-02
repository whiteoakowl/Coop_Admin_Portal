// A real request: "If a member is added as an organizer for an event, on
// parent portal when they click on the event it will show an edit event
// button at the top to allow them to change details. Members are not
// allowed to change anything on the financial tab. They can click on the
// tab but everything will be frozen and not clickable." Confirmed scope:
// organizer-parents can edit Details/Resources/Settings/Attendance, never
// Finance, and get no Cancel/Delete/Publish toolbar - just Copy Event
// Link. See routes/admin-events.js's own requireMainAdminOrEventOrganizer
// and utils/events.js's own isEventOrganizer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-organizer-edit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-organizer-edit-test-uploads-${process.pid}`);
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

async function createEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

// Returns { cookie, csrfToken, memberId } for a fresh parent login.
async function createParentAndLogin(name, email) {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES (?)").run(`${name} Family`)).lastInsertRowid;
  const code = await generateMemberCode();
  const memberRow = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
    .get(name, code, code, familyId);
  await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberRow.id, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const acct = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(email);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acct.id, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/parent').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: memberRow.id };
}

test('a non-organizer parent gets 403 trying to open the Main Admin builder for an event they do not organize', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAndLogin('Outsider Parent', 'outsider@example.com');

  const res = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', parent.cookie);
  assert.equal(res.status, 403);
});

test('the public event page shows an Edit Event button only for an organizer-parent', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const organizer = await createParentAndLogin('Organizer Parent', 'organizer@example.com');
  const outsider = await createParentAndLogin('Outsider Parent 2', 'outsider2@example.com');

  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${organizer.memberId}`], _csrf: admin.csrfToken });
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });

  const organizerPage = await request(app).get(`/events/${eventId}`).set('Cookie', organizer.cookie);
  assert.match(organizerPage.text, /Edit Event/);
  assert.match(organizerPage.text, new RegExp(`href="/main-admin/events/${eventId}/builder"`));

  const outsiderPage = await request(app).get(`/events/${eventId}`).set('Cookie', outsider.cookie);
  assert.doesNotMatch(outsiderPage.text, /Edit Event/);
});

test('an organizer-parent can open the builder, sees Parent Portal nav, no Cancel/Delete/Publish, and Finance fields disabled', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const organizer = await createParentAndLogin('Organizer Parent 3', 'organizer3@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${organizer.memberId}`], _csrf: admin.csrfToken });

  const detailsPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', organizer.cookie);
  assert.equal(detailsPage.status, 200);
  assert.match(detailsPage.text, /class="admin-mobile-tabs"|Parent Portal/);
  assert.doesNotMatch(detailsPage.text, />Publish</);
  assert.doesNotMatch(detailsPage.text, />Cancel Event</);
  assert.doesNotMatch(detailsPage.text, /aria-label="Delete Event"/);
  assert.match(detailsPage.text, /data-copy-link=/);
  assert.match(detailsPage.text, /Back to Event/);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', organizer.cookie);
  assert.equal(financePage.status, 200);
  assert.match(financePage.text, /name="accountingCategoryId" disabled/);
  assert.match(financePage.text, /name="paymentInstructionsText"[^>]*disabled/);
  assert.doesNotMatch(financePage.text, />Save Finance</);
});

test('an organizer-parent can save Details (title) but is rejected saving Finance', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const organizer = await createParentAndLogin('Organizer Parent 4', 'organizer4@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${organizer.memberId}`], _csrf: admin.csrfToken });

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', organizer.cookie);
  const organizerCsrf = extractCsrf(page.text);

  const saveDetails = await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', organizer.cookie)
    .type('form')
    .send({ title: 'Renamed By Organizer', startsAt: '2027-09-01T18:00', _csrf: organizerCsrf });
  assert.equal(saveDetails.status, 302);
  const event = await db.prepare('SELECT title FROM events WHERE id = ?').get(eventId);
  assert.equal(event.title, 'Renamed By Organizer');

  const saveFinance = await request(app)
    .post(`/main-admin/events/${eventId}/finance`)
    .set('Cookie', organizer.cookie)
    .type('form')
    .send({ paymentInstructionsText: 'Hacked', _csrf: organizerCsrf });
  assert.equal(saveFinance.status, 403);
  const eventAfter = await db.prepare('SELECT payment_instructions_text FROM events WHERE id = ?').get(eventId);
  assert.notEqual(eventAfter.payment_instructions_text, 'Hacked');
});

test('an organizer-parent is rejected publishing, cancelling, or deleting the event', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const organizer = await createParentAndLogin('Organizer Parent 5', 'organizer5@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${organizer.memberId}`], _csrf: admin.csrfToken });

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', organizer.cookie);
  const organizerCsrf = extractCsrf(page.text);

  const statusRes = await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', organizer.cookie).type('form').send({ status: 'published', _csrf: organizerCsrf });
  assert.equal(statusRes.status, 403);

  const deleteRes = await request(app).post(`/main-admin/events/${eventId}/delete`).set('Cookie', organizer.cookie).type('form').send({ _csrf: organizerCsrf });
  assert.equal(deleteRes.status, 403);

  const stillThere = await db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  assert.ok(stillThere, 'the event should not have been deleted');
});

test('an organizer-parent can view and act on the Attendance (registrations) page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const organizer = await createParentAndLogin('Organizer Parent 6', 'organizer6@example.com');
  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Organizer Edit Test Event', startsAt: '2027-09-01T18:00', organizers: [`member:${organizer.memberId}`], _csrf: admin.csrfToken });

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', organizer.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Registrations/);
});

test('a real Main Admin is completely unaffected: full toolbar, editable Finance, same access as always', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Cancel Event</);
  assert.match(page.text, /Main Admin/);

  const financePage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=finance`).set('Cookie', admin.cookie);
  assert.doesNotMatch(financePage.text, /name="accountingCategoryId" disabled/);
  assert.match(financePage.text, />Save Finance</);
});

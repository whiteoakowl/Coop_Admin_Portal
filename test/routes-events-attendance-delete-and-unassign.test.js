// Coverage for a real request: "Main admin portal. Edit events.
// Attendance. There should be a trash icons at the end of each member row
// to delete the registration. On parent portal view the volunteer, food,
// etc signups should be on one card after signing up at the bottom for
// viewing, with edit button if member needs to change their signup, and
// only asked when signing up. If member unregistered, they will be
// unassigned for the thing they signed up for so someone else can signup
// for it."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-attendance-delete-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-attendance-delete-test-uploads-${process.pid}`);
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

async function createEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Attendance Delete Event', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

async function addVolunteerRole(admin, eventId, roleName, slotsNeeded = 1) {
  await request(app).post(`/main-admin/events/${eventId}/volunteer-roles`).set('Cookie', admin.cookie).type('form').send({ roleName, slotsNeeded: String(slotsNeeded), _csrf: admin.csrfToken });
  const row = await db.prepare('SELECT id FROM event_volunteer_roles WHERE event_id = ? AND role_name = ?').get(eventId, roleName);
  return row.id;
}

async function addDonationItem(admin, eventId, itemName, quantityNeeded = 1) {
  await request(app).post(`/main-admin/events/${eventId}/donation-items`).set('Cookie', admin.cookie).type('form').send({ itemName, quantityNeeded: String(quantityNeeded), _csrf: admin.csrfToken });
  const row = await db.prepare('SELECT id FROM event_donation_items WHERE event_id = ? AND item_name = ?').get(eventId, itemName);
  return row.id;
}

async function addFoodItem(admin, eventId, itemName, quantityNeeded = 1) {
  await request(app).post(`/main-admin/events/${eventId}/food-items`).set('Cookie', admin.cookie).type('form').send({ itemName, quantityNeeded: String(quantityNeeded), _csrf: admin.csrfToken });
  const row = await db.prepare('SELECT id FROM event_food_items WHERE event_id = ? AND item_name = ?').get(eventId, itemName);
  return row.id;
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Attendance Delete Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Attendance Delete Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const email = `attendance-delete-parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

// A real follow-up request: "there should also be a cancel button next to
// each member. When you click cancel they remain on the roster and simply
// show as canceled" + "when you click the trash button it will delete
// their name from the roster completely and unregister them." The single
// trash-icon-that-just-cancels button from the original request is now
// two separate actions: a Cancel button (soft, stays on the roster,
// scoped to the above to still-active rows) and a trash icon (hard
// delete, always available, even on an already-cancelled row).
test('Attendance page: a Cancel button and a trash icon both render for an active member row, each with its own endpoint', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-cancel-endpoint="/main-admin/events/${eventId}/registrations/${registration.id}/cancel"`));
  assert.match(page.text, new RegExp(`data-delete-endpoint="/main-admin/events/${eventId}/registrations/${registration.id}/delete"`));
  assert.match(page.text, /js-registration-cancel[^>]*>Cancel</);
  assert.match(page.text, /icon-btn icon-btn-danger js-registration-delete[^>]*aria-label="Delete registration for Attendance Delete Parent/);
  assert.match(page.text, /<use href="#icon-trash"\/>/);
});

test('Attendance page: an already-cancelled row still gets a trash icon (so it can be cleaned off the roster), but no Cancel button', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  await db.prepare("UPDATE event_registrations SET status = 'cancelled' WHERE id = ?").run(registration.id);

  const page = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(page.text, new RegExp(`data-delete-endpoint="/main-admin/events/${eventId}/registrations/${registration.id}/delete"`));
  assert.doesNotMatch(page.text, new RegExp(`data-cancel-endpoint="/main-admin/events/${eventId}/registrations/${registration.id}/cancel"`));
});

test('Attendance page: clicking Cancel keeps the registration row - status flips to cancelled, nothing is deleted', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);
  assert.equal(registration.status, 'confirmed');

  const res = await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${registration.id}/cancel`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true }, 'a JSON response, not a redirect, so the roster page itself never has to reload');

  const cancelled = await db.prepare('SELECT * FROM event_registrations WHERE id = ?').get(registration.id);
  assert.equal(cancelled.status, 'cancelled');
});

test('Attendance page: clicking the trash icon removes the registration row completely', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);

  const res = await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${registration.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  assert.equal(await db.prepare('SELECT 1 FROM event_registrations WHERE id = ?').get(registration.id), undefined, 'the row must be gone entirely, not merely marked cancelled');
});

test('unregistering frees a claimed volunteer role so someone else can sign up for it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const roleId = await addVolunteerRole(admin, eventId, 'Door Greeter', 1);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  const other = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.ok(await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, parent.memberId));

  await request(app).post(`/events/${eventId}/unregister`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, parent.memberId), undefined, 'unregistering should free the volunteer slot');

  await request(app).post(`/events/${eventId}/register`).set('Cookie', other.cookie).type('form').send({ memberId: String(other.memberId), _csrf: other.csrfToken });
  const res = await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', other.cookie)
    .type('form')
    .send({ memberId: String(other.memberId), _csrf: other.csrfToken });
  assert.equal(res.status, 302);
  assert.ok(await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, other.memberId), 'another member should now be able to claim the freed slot');
});

test('unregistering frees claimed donation and food items', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const donationId = await addDonationItem(admin, eventId, 'Juice Boxes', 1);
  const foodId = await addFoodItem(admin, eventId, 'Cupcakes', 1);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app).post(`/events/${eventId}/donation-items/${donationId}/claim`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });
  await request(app).post(`/events/${eventId}/food-items/${foodId}/claim`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });
  assert.ok(await db.prepare('SELECT 1 FROM event_donation_claims WHERE donation_item_id = ? AND member_id = ?').get(donationId, parent.memberId));
  assert.ok(await db.prepare('SELECT 1 FROM event_food_claims WHERE food_item_id = ? AND member_id = ?').get(foodId, parent.memberId));

  await request(app).post(`/events/${eventId}/unregister`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(await db.prepare('SELECT 1 FROM event_donation_claims WHERE donation_item_id = ? AND member_id = ?').get(donationId, parent.memberId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM event_food_claims WHERE food_item_id = ? AND member_id = ?').get(foodId, parent.memberId), undefined);
});

test('Main Admin cancelling a registration from the roster (Cancel button route) also frees that member\'s volunteer signup', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const roleId = await addVolunteerRole(admin, eventId, 'Setup Crew', 1);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);

  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${registration.id}/cancel`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  assert.equal(await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, parent.memberId), undefined);
  const stillThere = await db.prepare('SELECT status FROM event_registrations WHERE id = ?').get(registration.id);
  assert.equal(stillThere.status, 'cancelled', 'Cancel keeps the row - it must not be deleted');
});

test('Main Admin deleting a registration from the roster (trash icon route) also frees that member\'s volunteer signup', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const roleId = await addVolunteerRole(admin, eventId, 'Setup Crew', 1);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registration = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parent.memberId);

  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${registration.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  assert.equal(await db.prepare('SELECT 1 FROM event_volunteer_signups WHERE volunteer_role_id = ? AND member_id = ?').get(roleId, parent.memberId), undefined);
  assert.equal(await db.prepare('SELECT 1 FROM event_registrations WHERE id = ?').get(registration.id), undefined, 'the row must be gone entirely');
});

test('Deleting a confirmed registration promotes the next waitlisted member, same as Cancel does', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { capacityValue: '1', capacityType: 'person' });
  await publishEvent(admin, eventId);

  const first = await createParentAccount();
  const waitlisted = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', first.cookie).type('form').send({ memberId: String(first.memberId), _csrf: first.csrfToken });
  await request(app).post(`/events/${eventId}/register`).set('Cookie', waitlisted.cookie).type('form').send({ memberId: String(waitlisted.memberId), _csrf: waitlisted.csrfToken });

  const firstReg = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, first.memberId);
  const waitlistedRegBefore = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, waitlisted.memberId);
  assert.equal(waitlistedRegBefore.status, 'waitlisted');

  await request(app)
    .post(`/main-admin/events/${eventId}/registrations/${firstReg.id}/delete`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });

  const waitlistedRegAfter = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, waitlisted.memberId);
  assert.equal(waitlistedRegAfter.status, 'confirmed', 'deleting the confirmed registration should open the seat up to the next waitlisted member');
});

test('Parent Portal event page: Volunteer/Donations/Food sections no longer render standalone - only inside the Register dialog and (once registered) the Edit Registration popup', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addVolunteerRole(admin, eventId, 'Snack Table', 2);
  const donationId = await addDonationItem(admin, eventId, 'Paper Plates', 2);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const beforePage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  // Before registering, the only place these sections appear at all is
  // as checkbox questions inside the Register dialog itself ("only asked
  // when signing up") - there is no standalone section heading or claim
  // form reachable outside that dialog yet (no Edit Registration popup
  // exists before the family has registered).
  assert.doesNotMatch(beforePage.text, /<h2>Donations Needed<\/h2>/);
  assert.doesNotMatch(beforePage.text, /I'll Bring It/);

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const afterPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  // After registering, the section's heading appears exactly once now -
  // inside the Edit Registration popup - not also duplicated standalone
  // on the page.
  const donationHeaderMatches = afterPage.text.match(/<h2>Donations Needed<\/h2>/g) || [];
  assert.equal(donationHeaderMatches.length, 1, 'Donations Needed should render exactly once (inside Edit Registration), not also standalone');
  const dialogHtml = afterPage.text.split('id="edit-registration-dialog"')[1].split('</dialog>')[0];
  assert.match(dialogHtml, /Donations Needed/);

  await request(app)
    .post(`/events/${eventId}/donation-items/${donationId}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });
  const afterClaimPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(afterClaimPage.text, /Donations Signed Up For/);
});

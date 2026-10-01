// A real request: "Parent portal, view event and register. After
// registering there will be a card below the registration card that says
// my registration. It will be one information card. Listing everyone
// signed up by this family in a single organized column, no register
// buttons next to members there. Then list volunteer positions signed up
// for, donations signed up for and food signed up for. Then a button
// that says edit registration. Click and see a popup that allows you to
// view what's left on those lists, unassigned what they signed up for
// and register for something else."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-my-registration-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-my-registration-test-uploads-${process.pid}`);
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
    .send({ title: 'My Registration Card Event', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

async function addVolunteerRole(admin, eventId, roleName, slotsNeeded = 5) {
  await request(app).post(`/main-admin/events/${eventId}/volunteer-roles`).set('Cookie', admin.cookie).type('form').send({ roleName, slotsNeeded: String(slotsNeeded), _csrf: admin.csrfToken });
  const row = await db.prepare('SELECT id FROM event_volunteer_roles WHERE event_id = ? AND role_name = ?').get(eventId, roleName);
  return row.id;
}

async function addDonationItem(admin, eventId, itemName, quantityNeeded = 5) {
  await request(app).post(`/main-admin/events/${eventId}/donation-items`).set('Cookie', admin.cookie).type('form').send({ itemName, quantityNeeded: String(quantityNeeded), _csrf: admin.csrfToken });
  const row = await db.prepare('SELECT id FROM event_donation_items WHERE event_id = ? AND item_name = ?').get(eventId, itemName);
  return row.id;
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`My Reg Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`My Reg Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const email = `my-reg-parent${familyCounter}@example.com`;
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

test('before registering, there is no "My Registration" card', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.doesNotMatch(page.text, /<h2>My Registration<\/h2>/);
  assert.doesNotMatch(page.text, /id="edit-registration-dialog"/);
});

test('after registering, the My Registration card lists the member with no register button, and an Edit Registration button/dialog appear', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /<h2>My Registration<\/h2>/);
  assert.match(page.text, /class="event-my-registration-row"[^<]*My Reg Parent/);
  assert.match(page.text, />Edit Registration</);
  assert.match(page.text, /id="edit-registration-dialog"/);

  // No register/unregister button inside the My Registration card's own
  // member column - only a plain name row.
  const memberColumn = page.text.split('<div class="event-my-registration-column">')[1].split('</div>')[0];
  assert.doesNotMatch(memberColumn, /roster-action-btn|<button|<form/, 'the My Registration summary column must not carry a register/unregister button');
});

test('My Registration lists volunteer/donation signups by name, and the Edit Registration dialog offers what\'s left plus a Remove button for existing picks', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const roleId = await addVolunteerRole(admin, eventId, 'Snack Table', 3);
  const itemId = await addDonationItem(admin, eventId, 'Paper Cups', 3);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/donation-items/${itemId}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /Volunteer Positions Signed Up For/);
  assert.match(page.text, /<li>Snack Table &mdash; My Reg Parent/);
  assert.match(page.text, /Donations Signed Up For/);
  assert.match(page.text, /<li>Paper Cups &mdash; My Reg Parent/);

  // The dialog reuses the same Sign Up/Cancel toggle the inline sections
  // use, so an existing pick shows a Cancel (= "unassign") button, and
  // remaining capacity ("2 spots left"/"2 still needed") is visible.
  const dialogHtml = page.text.split('id="edit-registration-dialog"')[1].split('</dialog>')[0];
  assert.match(dialogHtml, /My Reg Parent \d+: Cancel/);
  assert.match(dialogHtml, /2 spot/);
  assert.match(dialogHtml, /2 still needed/);
});

test('cancelling a donation claim through the new /donation-claims/:id/cancel route actually removes it', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const itemId = await addDonationItem(admin, eventId, 'Napkins', 5);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/donation-items/${itemId}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });

  const claim = await db.prepare('SELECT id FROM event_donation_claims WHERE donation_item_id = ? AND member_id = ?').get(itemId, parent.memberId);
  assert.ok(claim);

  const res = await request(app)
    .post(`/events/${eventId}/donation-claims/${claim.id}/cancel`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(res.status, 302);

  const gone = await db.prepare('SELECT id FROM event_donation_claims WHERE id = ?').get(claim.id);
  assert.equal(gone, undefined);
});

test('cancelling a food claim through the new /food-claims/:id/cancel route actually removes it, and a family member can only cancel their own family\'s claim', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await request(app).post(`/main-admin/events/${eventId}/food-items`).set('Cookie', admin.cookie).type('form').send({ itemName: 'Cookies', quantityNeeded: '5', _csrf: admin.csrfToken });
  const item = await db.prepare('SELECT id FROM event_food_items WHERE event_id = ?').get(eventId);
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  const outsider = await createParentAccount();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  await request(app)
    .post(`/events/${eventId}/food-items/${item.id}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '1', _csrf: parent.csrfToken });
  const claim = await db.prepare('SELECT id FROM event_food_claims WHERE food_item_id = ? AND member_id = ?').get(item.id, parent.memberId);

  // An outsider can only ever submit a memberId from their OWN family
  // (the route's family.some(...) check rejects anyone else's id
  // outright) - cancelFoodClaim's own WHERE id = ? AND member_id = ?
  // then simply matches no row for a memberId that never claimed it, so
  // the real claim survives untouched either way.
  await request(app)
    .post(`/events/${eventId}/food-claims/${claim.id}/cancel`)
    .set('Cookie', outsider.cookie)
    .type('form')
    .send({ memberId: String(outsider.memberId), _csrf: outsider.csrfToken });
  assert.ok(await db.prepare('SELECT id FROM event_food_claims WHERE id = ?').get(claim.id), 'an outsider must not be able to cancel someone else\'s claim');

  await request(app)
    .post(`/events/${eventId}/food-claims/${claim.id}/cancel`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.equal(await db.prepare('SELECT id FROM event_food_claims WHERE id = ?').get(claim.id), undefined);
});

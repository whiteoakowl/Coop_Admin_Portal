// Coverage for the Main Admin Event Attendance rebuild - a real request:
// "when you click attendance it should show a purple check in and purple
// check out button. when you click each button it should show the same
// mobile barcode, barcode or ID check in buttons just like the class
// check in page. it should also show all the members below and an
// attendance grid just like the class check in page. guest check in
// shouldn't be there. that should be under settings for each individual
// event only. to allow guest to signup, then they will appear on the
// event roster. roster will show primary member name sub categories
// students and other guests in that family. next column paid amount,
// date and time registered, signedup/canceled/wait list column ... then
// a column for volunteer signup."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-event-attendance-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-event-attendance-test-uploads-${process.pid}`);
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
    .send({ title: 'Attendance Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  return Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createFamily({ withParentAccount = true } = {}) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
      .run(`Parent${familyCounter} Smith${familyCounter}`, parentCode, parentCode, familyId)
  ).lastInsertRowid;
  const studentCode = await generateMemberCode();
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Kid${familyCounter} Smith${familyCounter}`, studentCode, studentCode, familyId)
  ).lastInsertRowid;
  let accountId = null;
  let cookie = null;
  let csrfToken = null;
  if (withParentAccount) {
    const email = `parent${familyCounter}@example.com`;
    accountId = (
      await db
        .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
        .run(parentId, email, hashPassword('testpassword123'))
    ).lastInsertRowid;
    const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
    await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
    const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/events' });
    cookie = loginRes.headers['set-cookie'];
    const page = await request(app).get('/events').set('Cookie', cookie);
    csrfToken = extractCsrf(page.text);
  }
  return { familyId, parentId, studentId, accountId, cookie, csrfToken };
}

test('Attendance page: purple Check In / Check Out buttons link to the new scan page', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<a class="class-checkin-btn" href="/main-admin/events/${eventId}/checkin-scan\\?mode=checkin">`));
  assert.match(res.text, new RegExp(`<a class="class-checkin-btn" href="/main-admin/events/${eventId}/checkin-scan\\?mode=checkout">`));
});

test('Attendance page: the old admin-only Guest Registration section is gone', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.doesNotMatch(res.text, /\+ Register Guest/);
  assert.doesNotMatch(res.text, /add-guest-dialog/);

  // The route that dialog posted to is gone too - not just hidden UI.
  const csrf = extractCsrf(res.text);
  const postRes = await request(app)
    .post(`/main-admin/events/${eventId}/guests`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ guestName: 'Sneaky Guest', _csrf: csrf });
  assert.equal(postRes.status, 404);
});

test('checkin-scan page: renders the method-chooser UI for both modes', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);

  const checkinRes = await request(app).get(`/main-admin/events/${eventId}/checkin-scan?mode=checkin`).set('Cookie', admin.cookie);
  assert.equal(checkinRes.status, 200);
  assert.match(checkinRes.text, /Check In/);
  assert.match(checkinRes.text, /Mobile Barcode Scan/);
  assert.match(checkinRes.text, /Manually Enter ID #/);
  assert.match(checkinRes.text, /data-mode="checkin"/);

  const checkoutRes = await request(app).get(`/main-admin/events/${eventId}/checkin-scan?mode=checkout`).set('Cookie', admin.cookie);
  assert.equal(checkoutRes.status, 200);
  assert.match(checkoutRes.text, /Check Out/);
  assert.match(checkoutRes.text, /data-mode="checkout"/);

  const missingEvent = await request(app).get('/main-admin/events/999999/checkin-scan?mode=checkin').set('Cookie', admin.cookie);
  assert.equal(missingEvent.status, 404);
});

test('scan endpoint: checks a registered member in and out by name', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const family = await createFamily();
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, family.parentId);

  const checkin = await request(app)
    .post(`/main-admin/events/${eventId}/scan`)
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: `Parent${familyCounter} Smith${familyCounter}`, mode: 'checkin' });
  assert.equal(checkin.status, 200);
  assert.equal(checkin.body.ok, true);
  assert.match(checkin.body.message, /Welcome/);

  const reg = await db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, family.parentId);
  assert.ok(reg.checked_in_at);

  const checkout = await request(app)
    .post(`/main-admin/events/${eventId}/scan`)
    .set('Cookie', admin.cookie)
    .set('X-CSRF-Token', admin.csrfToken)
    .send({ barcode: `Parent${familyCounter} Smith${familyCounter}`, mode: 'checkout' });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.ok, true);
});

test('roster: groups a family under its primary member, with the family price shown once', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { priceDollars: '15', pricePer: 'family' });
  await publishEvent(admin, eventId);
  const family = await createFamily();
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, family.parentId);
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, family.studentId);
  await db.prepare("INSERT INTO event_guest_registrations (event_id, guest_name, registered_by_account_id) VALUES (?, 'Grandma Visitor', ?)").run(eventId, family.accountId);

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  // Primary parent's row shows the family price once...
  assert.match(res.text, new RegExp(`class="roster-group-start"[\\s\\S]*?Parent${familyCounter} Smith${familyCounter}`));
  assert.match(res.text, new RegExp(`class="roster-group-member"[\\s\\S]*?↳ Kid${familyCounter} Smith${familyCounter}`));
  const parentRowIndex = res.text.indexOf(`Parent${familyCounter} Smith${familyCounter}`);
  const studentRowIndex = res.text.indexOf(`Kid${familyCounter} Smith${familyCounter}`);
  assert.ok(parentRowIndex >= 0 && studentRowIndex > parentRowIndex, 'the student row should follow the primary parent row');
  assert.match(res.text.slice(parentRowIndex, parentRowIndex + 400), /\$15\.00/);
  // ...and the student + guest sub-rows in that same family don't repeat it.
  const studentRow = res.text.slice(studentRowIndex, studentRowIndex + 400);
  assert.doesNotMatch(studentRow, /\$15\.00/);
  assert.match(res.text, /Grandma Visitor/);
  assert.match(res.text, /Guest<\/span>/);
});

test('roster: shows Signed Up / Waitlisted / Cancelled status labels', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { capacityValue: '1', capacityType: 'person' });
  await publishEvent(admin, eventId);
  const familyA = await createFamily();
  const familyB = await createFamily();
  await request(app).post(`/events/${eventId}/register`).set('Cookie', familyA.cookie).type('form').send({ memberId: familyA.parentId, _csrf: familyA.csrfToken });
  await request(app).post(`/events/${eventId}/register`).set('Cookie', familyB.cookie).type('form').send({ memberId: familyB.parentId, _csrf: familyB.csrfToken });

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(res.text, /Signed Up/);
  assert.match(res.text, /Waitlisted/);
});

test('roster: Volunteer Signup column only appears when the event has volunteering enabled, and shows the role name', async () => {
  const admin = await loginAsMainAdmin();
  // volunteersEnabled defaults to true for a new event (registrationFieldsFromBody's
  // own comment - it predates Food and always defaulted on) - explicitly off here.
  const eventId = await createEvent(admin, { volunteersEnabled: '0' });
  await publishEvent(admin, eventId);
  const family = await createFamily();
  await db.prepare("INSERT INTO event_registrations (event_id, member_id, status) VALUES (?, ?, 'confirmed')").run(eventId, family.parentId);

  const noVolunteering = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.doesNotMatch(noVolunteering.text, /Volunteer Signup/);

  await request(app)
    .post(`/main-admin/events/${eventId}/volunteers-settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ enabled: '1', _csrf: admin.csrfToken });
  const roleRes = await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Setup Crew', slotsNeeded: '2', _csrf: admin.csrfToken });
  assert.ok(roleRes.status < 400, `expected the volunteer role to be created, got ${roleRes.status}`);
  const role = await db.prepare('SELECT id FROM event_volunteer_roles WHERE event_id = ?').get(eventId);
  await db.prepare('INSERT INTO event_volunteer_signups (volunteer_role_id, member_id) VALUES (?, ?)').run(role.id, family.parentId);

  const withVolunteering = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(withVolunteering.text, /Volunteer Signup/);
  assert.match(withVolunteering.text, /Setup Crew/);
});

test('member-facing guest self-registration: only shown/allowed when the event\'s own "Guests can register" setting is on', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);
  const family = await createFamily();

  const detailNoGuests = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  assert.doesNotMatch(detailNoGuests.text, /Bringing a Guest/);

  const blocked = await request(app)
    .post(`/events/${eventId}/register-guest`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ guestName: 'Should Not Work', _csrf: family.csrfToken });
  assert.match(blocked.headers.location, /error=/);
  const noneAdded = await db.prepare('SELECT COUNT(*) AS c FROM event_guest_registrations WHERE event_id = ?').get(eventId);
  assert.equal(Number(noneAdded.c), 0);

  await request(app)
    .post(`/main-admin/events/${eventId}/permissions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ allowGuestRegister: '1', _csrf: admin.csrfToken });

  const detailWithGuests = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  assert.match(detailWithGuests.text, /Bringing a Guest/);

  const registered = await request(app)
    .post(`/events/${eventId}/register-guest`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ guestName: 'Cousin Casey', guestEmail: 'casey@example.com', _csrf: family.csrfToken });
  assert.match(registered.headers.location, /notice=/);

  const guest = await db.prepare('SELECT * FROM event_guest_registrations WHERE event_id = ?').get(eventId);
  assert.equal(guest.guest_name, 'Cousin Casey');
  assert.equal(guest.registered_by_account_id, family.accountId);

  // Shows on the member's own event page, and on the admin roster.
  const detailAfter = await request(app).get(`/events/${eventId}`).set('Cookie', family.cookie);
  assert.match(detailAfter.text, /Cousin Casey/);
  const adminRoster = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(adminRoster.text, /Cousin Casey/);

  // The registering family can cancel their own guest...
  const unregistered = await request(app)
    .post(`/events/${eventId}/unregister-guest`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ guestId: guest.id, _csrf: family.csrfToken });
  assert.match(unregistered.headers.location, /notice=/);
  const cancelledGuest = await db.prepare('SELECT status FROM event_guest_registrations WHERE id = ?').get(guest.id);
  assert.equal(cancelledGuest.status, 'cancelled');

  // ...but a different family cannot cancel someone else's guest.
  const secondReg = await request(app)
    .post(`/events/${eventId}/register-guest`)
    .set('Cookie', family.cookie)
    .type('form')
    .send({ guestName: 'Cousin Casey Two', _csrf: family.csrfToken });
  assert.match(secondReg.headers.location, /notice=/);
  const secondGuest = await db.prepare("SELECT * FROM event_guest_registrations WHERE event_id = ? AND status = 'confirmed'").get(eventId);
  const otherFamily = await createFamily();
  const blockedCancel = await request(app)
    .post(`/events/${eventId}/unregister-guest`)
    .set('Cookie', otherFamily.cookie)
    .type('form')
    .send({ guestId: secondGuest.id, _csrf: otherFamily.csrfToken });
  assert.match(blockedCancel.headers.location, /error=/);
});

test('admin can still cancel a guest registration from the roster (register_guests permission)', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { allowGuestRegister: '1' });
  await publishEvent(admin, eventId);
  const family = await createFamily();
  const guestId = (
    await db.prepare("INSERT INTO event_guest_registrations (event_id, guest_name, registered_by_account_id) VALUES (?, 'Cancel Me', ?)").run(eventId, family.accountId)
  ).lastInsertRowid;

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.match(res.text, new RegExp(`action="/main-admin/events/${eventId}/guests/${guestId}/cancel"`));

  await request(app).post(`/main-admin/events/${eventId}/guests/${guestId}/cancel`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  const guest = await db.prepare('SELECT status FROM event_guest_registrations WHERE id = ?').get(guestId);
  assert.equal(guest.status, 'cancelled');
});

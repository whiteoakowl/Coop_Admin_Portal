// Route-level coverage for Events (Community & Commerce track, item 1),
// bundled with Volunteer signups (item 2) and Donation signups (item 3)
// since they hang directly off the same event. See TEAM_B_HANDOFF.md and
// utils/events.js's own comments for the design this exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-test-uploads-${process.pid}`);
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

// Creates a real parent portal account with a family of `extraMembers`
// additional members sharing its family_id, mirroring how
// routes/portal-auth.js's own self-registration + Main Admin approval
// flow ends up shaping the data (just skipping straight to 'active'
// status instead of going through /register + approval, since that flow
// itself isn't what this file is testing).
let familyCounter = 0;
async function createParentAccount(extraMembers = 0) {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const others = [];
  for (let i = 0; i < extraMembers; i++) {
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Child ${familyCounter}-${i}`, code, code, familyId);
    others.push(info.lastInsertRowid);
  }
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyMemberIds: others };
}

async function createEvent(admin, overrides = {}) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Fall Picnic', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const match = /\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location);
  return Number(match[1]);
}

async function publishEvent(admin, eventId) {
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
}

test('main admin can create, publish, and manage an event', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public' });

  const builderBefore = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builderBefore.text, /Draft/);

  await publishEvent(admin, eventId);
  const builderAfter = await request(app).get(`/main-admin/events/${eventId}/builder`).set('Cookie', admin.cookie);
  assert.match(builderAfter.text, /Published/);

  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(event.status, 'published');
  assert.equal(event.visibility, 'public');
});

test('a signed-out visitor sees only public events, not members-only ones', async () => {
  const admin = await loginAsMainAdmin();
  const publicEventId = await createEvent(admin, { title: 'Public Bake Sale', visibility: 'public' });
  const membersEventId = await createEvent(admin, { title: 'Members Only Meetup', visibility: 'members' });
  await publishEvent(admin, publicEventId);
  await publishEvent(admin, membersEventId);

  const list = await request(app).get('/events');
  assert.match(list.text, /Public Bake Sale/);
  assert.doesNotMatch(list.text, /Members Only Meetup/);

  const detail = await request(app).get(`/events/${membersEventId}`);
  assert.equal(detail.status, 302);
  assert.match(detail.headers.location, /^\/login\?next=/);
});

test('a signed-in account sees members-only events too', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Members Movie Night', visibility: 'members' });
  await publishEvent(admin, eventId);

  const parent = await createParentAccount();
  const list = await request(app).get('/events').set('Cookie', parent.cookie);
  assert.match(list.text, /Members Movie Night/);
});

test('a parent can register themselves and their family, and capacity waitlists overflow', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Small Workshop', visibility: 'public', capacityValue: '1', capacityType: 'person' });
  await publishEvent(admin, eventId);

  const parent = await createParentAccount(1);
  const child = parent.familyMemberIds[0];

  const first = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.match(first.headers.location, /notice=/);
  assert.doesNotMatch(first.headers.location, /waitlist/);

  const second = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(child), _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(second.headers.location), /waitlist/);

  const rows = await db.prepare('SELECT member_id, status FROM event_registrations WHERE event_id = ? ORDER BY id').all(eventId);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['confirmed', 'waitlisted']
  );
});

test('an account cannot register a member outside its own family', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Family Fun Day', visibility: 'public' });
  await publishEvent(admin, eventId);

  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), _csrf: parentA.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /You can only register yourself or your own family/);

  const row = await db.prepare('SELECT 1 FROM event_registrations WHERE event_id = ? AND member_id = ?').get(eventId, parentB.memberId);
  assert.equal(row, undefined);
});

test('volunteer role signup fills slots and rejects once full', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Cleanup Day', visibility: 'public' });
  await request(app)
    .post(`/main-admin/events/${eventId}/volunteer-roles`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ roleName: 'Trash Crew', slotsNeeded: '1', _csrf: admin.csrfToken });
  await publishEvent(admin, eventId);
  const event = await db.prepare('SELECT id FROM event_volunteer_roles WHERE event_id = ?').get(eventId);
  const roleId = event.id;

  const parent1 = await createParentAccount();
  const parent2 = await createParentAccount();

  const signup1 = await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent1.cookie)
    .type('form')
    .send({ memberId: String(parent1.memberId), _csrf: parent1.csrfToken });
  assert.match(decodeURIComponent(signup1.headers.location), /Signed up to volunteer/);

  const signup2 = await request(app)
    .post(`/events/${eventId}/volunteer-roles/${roleId}/signup`)
    .set('Cookie', parent2.cookie)
    .type('form')
    .send({ memberId: String(parent2.memberId), _csrf: parent2.csrfToken });
  assert.match(decodeURIComponent(signup2.headers.location), /already full/);

  const signups = await db.prepare('SELECT member_id FROM event_volunteer_signups WHERE volunteer_role_id = ?').all(roleId);
  assert.equal(signups.length, 1);
  assert.equal(signups[0].member_id, parent1.memberId);
});

test('donation claim clamps to what is actually still needed', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'Potluck', visibility: 'public' });
  await request(app)
    .post(`/main-admin/events/${eventId}/donation-items`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ itemName: 'Napkins', quantityNeeded: '2', _csrf: admin.csrfToken });
  await publishEvent(admin, eventId);
  const item = await db.prepare('SELECT id FROM event_donation_items WHERE event_id = ?').get(eventId);

  const parent = await createParentAccount();
  const claim = await request(app)
    .post(`/events/${eventId}/donation-items/${item.id}/claim`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), quantity: '5', _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(claim.headers.location), /2 claimed/);

  const claimed = Number((await db.prepare('SELECT COALESCE(SUM(quantity_claimed), 0) AS q FROM event_donation_claims WHERE donation_item_id = ?').get(item.id)).q);
  assert.equal(claimed, 2);

  const secondParent = await createParentAccount();
  const secondClaim = await request(app)
    .post(`/events/${eventId}/donation-items/${item.id}/claim`)
    .set('Cookie', secondParent.cookie)
    .type('form')
    .send({ memberId: String(secondParent.memberId), quantity: '1', _csrf: secondParent.csrfToken });
  assert.match(decodeURIComponent(secondClaim.headers.location), /no longer needs any more/);
});

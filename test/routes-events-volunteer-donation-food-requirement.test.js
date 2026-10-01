// Two real requests, both about Edit Event's Volunteer/Donations/Food
// sections:
// 1. "if these items are selected when editing the event with options
//    added. Then member should be asked when clicking register along
//    with the extra fields questions" - the Register dialog now also
//    offers these sections' own open roles/items, not just tickets/
//    extra fields, and registerForEvent (utils/events.js) enforces each
//    section's own minimum right there.
// 2. "On volunteer, donations and food signup pages there should also be
//    a question that says Require for each attendees or each family" -
//    'attendee' means every registering member individually must clear
//    the minimum; 'family' (the default) means the whole family only
//    needs to clear it once between them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `events-vol-don-food-req-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `events-vol-don-food-req-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const events = require('../utils/events');
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
    .send({ title: 'Volunteer Requirement Event', startsAt: '2027-09-01T18:00', visibility: 'public', _csrf: admin.csrfToken, ...overrides });
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

async function saveVolunteerSettings(admin, eventId, { enabled = true, selectionCount, requirementScope } = {}) {
  await request(app)
    .post(`/main-admin/events/${eventId}/volunteers-settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ enabled: enabled ? '1' : '0', selectionCount: selectionCount != null ? String(selectionCount) : '', requirementScope, _csrf: admin.csrfToken });
}

async function saveDonationSettings(admin, eventId, { enabled = true, selectionCount, requirementScope } = {}) {
  await request(app)
    .post(`/main-admin/events/${eventId}/donations-settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ enabled: enabled ? '1' : '0', selectionCount: selectionCount != null ? String(selectionCount) : '', requirementScope, _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createParentAccount(extraMembers = 0) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Req Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Req Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const others = [];
  for (let i = 0; i < extraMembers; i++) {
    const code = await generateMemberCode();
    const info = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
      .run(`Req Child ${familyCounter}-${i}`, code, code, familyId);
    others.push(info.lastInsertRowid);
  }
  const email = `req-parent${familyCounter}@example.com`;
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

// registerForEvent reads real member fields (name, family_id, birthday,
// etc.) off each `family` entry - same full-row shape utils/portalAuth.js's
// own familyForAccount returns, not a bare {id} stub.
async function familyRows(memberIds) {
  const rows = [];
  for (const id of memberIds) rows.push(await db.prepare('SELECT * FROM members WHERE id = ?').get(id));
  return rows;
}

test('the requirement-scope radio persists (attendee vs. family) alongside selectionCount', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await saveVolunteerSettings(admin, eventId, { selectionCount: 2, requirementScope: 'attendee' });

  let row = await db.prepare('SELECT volunteer_selection_count, volunteer_requirement_scope FROM events WHERE id = ?').get(eventId);
  assert.equal(Number(row.volunteer_selection_count), 2);
  assert.equal(row.volunteer_requirement_scope, 'attendee');

  await saveVolunteerSettings(admin, eventId, { selectionCount: 3, requirementScope: 'family' });
  row = await db.prepare('SELECT volunteer_selection_count, volunteer_requirement_scope FROM events WHERE id = ?').get(eventId);
  assert.equal(Number(row.volunteer_selection_count), 3, 'the selectionCount dropdown bug fix must still hold alongside the new scope field');
  assert.equal(row.volunteer_requirement_scope, 'family');
});

test('defaults to "family" scope when no radio is submitted', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await saveVolunteerSettings(admin, eventId, { selectionCount: 1 });
  const row = await db.prepare('SELECT volunteer_requirement_scope FROM events WHERE id = ?').get(eventId);
  assert.equal(row.volunteer_requirement_scope, 'family');
});

test('the Register dialog offers open volunteer roles and donation items alongside extra fields, and needsDialog turns on', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addVolunteerRole(admin, eventId, 'Setup Crew');
  await saveVolunteerSettings(admin, eventId, { selectionCount: 1, requirementScope: 'attendee' });
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.match(page.text, /data-needs-dialog="1"/);
  assert.match(page.text, /name="volunteerRoleIds" value="\d+"/);
  assert.match(page.text, /Setup Crew/);
});

test('attendee scope: each registering family member must individually meet the minimum', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const roleId = await addVolunteerRole(admin, eventId, 'Attendee Scope Role', 10);
  await saveVolunteerSettings(admin, eventId, { selectionCount: 1, requirementScope: 'attendee' });
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);
  const childId = parent.familyMemberIds[0];
  const family = await familyRows([parent.memberId, childId]);

  const blocked = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: null, family, answers: {} });
  assert.equal(blocked.ok, false, 'no volunteer role selected - attendee scope must reject');
  assert.match(blocked.error, /at least 1 volunteer role/);

  const parentOk = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: null, family, answers: {}, volunteerRoleIds: [roleId] });
  assert.equal(parentOk.ok, true, 'the parent selected a role, so their own registration succeeds');

  // The child still needs their OWN selection under attendee scope - the
  // parent already picking a role does not cover them.
  const childBlocked = await events.registerForEvent({ eventId, memberId: childId, accountId: null, family, answers: {} });
  assert.equal(childBlocked.ok, false, 'attendee scope: the child must select their own role even though the parent already did');

  const signupCount = await db.prepare('SELECT COUNT(*) AS c FROM event_volunteer_signups WHERE volunteer_role_id = ?').get(roleId);
  assert.equal(Number(signupCount.c), 1, 'only the parent\'s own signup should have been recorded');
});

test('family scope: once any family member clears the minimum, the rest of the family can register freely', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const itemId = await addDonationItem(admin, eventId, 'Family Scope Snacks', 10);
  await saveDonationSettings(admin, eventId, { selectionCount: 1, requirementScope: 'family' });
  await publishEvent(admin, eventId);
  const parent = await createParentAccount(1);
  const childId = parent.familyMemberIds[0];
  const family = await familyRows([parent.memberId, childId]);

  const parentOk = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: null, family, answers: {}, donationItemIds: [itemId] });
  assert.equal(parentOk.ok, true);

  // The child registers with NO selections of their own - family scope
  // already cleared by the parent.
  const childOk = await events.registerForEvent({ eventId, memberId: childId, accountId: null, family, answers: {} });
  assert.equal(childOk.ok, true, 'family scope: the family already met the minimum, so the child needs no selection of their own');

  const claimCount = await db.prepare('SELECT COUNT(*) AS c FROM event_donation_claims WHERE donation_item_id = ?').get(itemId);
  assert.equal(Number(claimCount.c), 1);
});

test('family scope still blocks registration when nobody in the family has met the minimum yet', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addDonationItem(admin, eventId, 'Unmet Family Snacks', 10);
  await saveDonationSettings(admin, eventId, { selectionCount: 1, requirementScope: 'family' });
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: null, family: await familyRows([parent.memberId]), answers: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Your family must select at least 1 donation item/);
});

test('a section with no minimum set imposes no requirement at all', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await addVolunteerRole(admin, eventId, 'No Minimum Role');
  await saveVolunteerSettings(admin, eventId, { selectionCount: null, requirementScope: 'attendee' });
  await publishEvent(admin, eventId);
  const parent = await createParentAccount();

  const result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: null, family: await familyRows([parent.memberId]), answers: {} });
  assert.equal(result.ok, true);
});

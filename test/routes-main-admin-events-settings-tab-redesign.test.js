// A real request: "event setting check boxes or yes/no in a column on
// the left, question to the right. questions with check boxes is this a
// public event, allow refunds when member cancels registration, close
// event, allow registration cancelations, allow members to register
// guests, allow other members to see who is registered for the event,
// only track participants. grade level multiple choice, age multiple
// choice check boxes next to both that say lock registration to age
// level or lock registration to grade level. checkbox lock registration
// to section, drop down of sections. lock registration to only be
// viewable to one section check box and dropdown."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-events-settings-tab-redesign-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-events-settings-tab-redesign-test-uploads-${process.pid}`);
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
    .send({ title: 'Settings Redesign Test Event', startsAt: '2027-09-01T18:00', _csrf: admin.csrfToken, ...overrides });
  const eventId = Number(/\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1]);
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

let familyCounter = 0;
async function createParentAccount(birthday) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Redesign Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active, birthday, grade_level) VALUES (?, ?, ?, 'parent', ?, 1, 1, ?, ?)")
    .run(`Redesign Parent ${familyCounter}`, code, code, familyId, birthday || null, null);
  const email = `redesign-parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/events' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/events').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: memberInfo.lastInsertRowid, accountId: accountInfo.lastInsertRowid };
}

test('Settings tab renders the new yes/no question list, grade/age locks, and section locks', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const section = await db.prepare("INSERT INTO sections (name) VALUES ('Redesign Section') RETURNING id").get();

  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=settings`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  const groupMatch = /checkbox-group checkbox-group-stack">([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(groupMatch, 'expected the stacked checkbox-group of yes/no questions');
  const group = groupMatch[1];
  [
    'Is this a public event?',
    'Allow refunds when a member cancels their registration?',
    'Close event?',
    'Allow registration cancellations?',
    'Allow members to register guests?',
    'Allow other members to see who is registered for this event?',
    'Only track participants?',
  ].forEach((question) => {
    assert.match(group, new RegExp(question.replace(/[?]/g, '\\?')), `expected "${question}" in the checkbox-group`);
  });
  // Each question is checkbox-first, text after (checkbox on the left).
  assert.match(group, /<input type="checkbox" name="isPublicEvent" value="1"[^>]*\/> Is this a public event\?/);

  assert.match(page.text, /> Lock registration to grade level</);
  assert.match(page.text, /> Lock registration to age level</);
  assert.match(page.text, /name="ageGroupRestriction" value="under5"/);
  assert.match(page.text, /> Lock registration to section</);
  assert.match(page.text, /> Lock registration to only be viewable to one section</);
  assert.match(page.text, new RegExp(`<option value="${section.id}"[^>]*>Redesign Section</option>`));
});

test('saving Settings: isPublicEvent controls visibility (moved from Details), and the new booleans persist', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const page = await request(app).get(`/main-admin/events/${eventId}/builder?tab=settings`).set('Cookie', admin.cookie);
  const csrf = extractCsrf(page.text);

  await request(app)
    .post(`/main-admin/events/${eventId}/permissions`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      isPublicEvent: '1',
      allowRefundOnCancel: '1',
      isClosed: '1',
      allowRegistrationCancellations: 'off',
      showRegistrantsToMembers: '1',
      trackParticipantsOnly: '1',
      _csrf: csrf,
    });

  const event = await events.getEvent(eventId);
  assert.equal(event.visibility, 'public');
  assert.equal(event.allow_refund_on_cancel, 1);
  assert.equal(event.is_closed, 1);
  assert.equal(event.allow_registration_cancellations, 0);
  assert.equal(event.show_registrants_to_members, 1);
  assert.equal(event.track_participants_only, 1);

  // Unchecking isPublicEvent goes back to members-only.
  const csrf2 = extractCsrf((await request(app).get(`/main-admin/events/${eventId}/builder?tab=settings`).set('Cookie', admin.cookie)).text);
  await request(app).post(`/main-admin/events/${eventId}/permissions`).set('Cookie', admin.cookie).type('form').send({ _csrf: csrf2 });
  assert.equal((await events.getEvent(eventId)).visibility, 'members');
});

test('Close Event blocks new registrations', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();

  await db.prepare('UPDATE events SET is_closed = 1 WHERE id = ?').run(eventId);
  const result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [{ id: parent.memberId, member_type: 'parent', birthday: null, grade_level: null }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /closed/i);
});

test('Allow Registration Cancellations = off blocks a member\'s own self-service cancel', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();

  await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  const registered = await db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status != 'cancelled'").get(eventId, parent.memberId);
  assert.ok(registered, 'expected the registration to succeed');

  await db.prepare('UPDATE events SET allow_registration_cancellations = 0 WHERE id = ?').run(eventId);
  const blocked = await request(app)
    .post(`/events/${eventId}/unregister`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.match(blocked.headers.location, /error=/);
  const stillActive = await db.prepare("SELECT * FROM event_registrations WHERE event_id = ? AND member_id = ? AND status != 'cancelled'").get(eventId, parent.memberId);
  assert.ok(stillActive, 'the registration should still be active - cancellation was blocked');
});

test('Lock registration to grade level: only enforced when the lock checkbox is on', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();
  const member = { id: parent.memberId, member_type: 'parent', birthday: null, grade_level: '3rd Grade' };

  // Grades checked, but lock is OFF - unrestricted.
  await db.prepare("UPDATE events SET age_group = 'Kindergarten', lock_registration_to_grade = 0 WHERE id = ?").run(eventId);
  let result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(result.ok, true, 'lock is off, so the grade restriction should not apply yet');

  await events.cancelRegistration(eventId, parent.memberId);

  // Same grades, lock ON - now enforced, and this member's grade isn't included.
  await db.prepare('UPDATE events SET lock_registration_to_grade = 1 WHERE id = ?').run(eventId);
  result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(result.ok, false);
  assert.match(result.error, /grades/i);
});

test('Lock registration to age level: uses the AGE_GROUPS buckets, only enforced when locked', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();
  const adultBirthday = '1980-01-01';
  const member = { id: parent.memberId, member_type: 'parent', birthday: adultBirthday, grade_level: null };

  await db.prepare("UPDATE events SET age_group_restriction = 'under5', lock_registration_to_age = 1 WHERE id = ?").run(eventId);
  const result = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(result.ok, false);
  assert.match(result.error, /ages/i);

  await db.prepare('UPDATE events SET lock_registration_to_age = 0 WHERE id = ?').run(eventId);
  const result2 = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(result2.ok, true);
});

test('Lock registration to section: member must belong to the single locked section', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();
  const section = await db.prepare("INSERT INTO sections (name) VALUES ('Register Lock Section') RETURNING id").get();

  await db.prepare('UPDATE events SET lock_registration_to_section = 1, registration_section_id = ? WHERE id = ?').run(section.id, eventId);
  const member = { id: parent.memberId, member_type: 'parent', birthday: null, grade_level: null };
  const blocked = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /section/i);

  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(parent.memberId, section.id);
  const allowed = await events.registerForEvent({ eventId, memberId: parent.memberId, accountId: parent.accountId, family: [member] });
  assert.equal(allowed.ok, true);
});

test('Lock visibility to one section: event is hidden from a family with no member in that section', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  const parent = await createParentAccount();
  const section = await db.prepare("INSERT INTO sections (name) VALUES ('Visibility Lock Section') RETURNING id").get();
  await db.prepare('UPDATE events SET lock_visibility_to_section = 1, visibility_section_id = ? WHERE id = ?').run(section.id, eventId);

  const hidden = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(hidden.status, 404);

  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(parent.memberId, section.id);
  const visible = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(visible.status, 200);
});

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

test('Event Attendance (registrations) page: a plain "Edit Event" back link on its own row, no "All Events" button', async () => {
  // A real bug report: "when you click the back button it goes to
  // something went wrong then the kiosk homepage." A real <a> link back
  // to the event this page is reached from is never at the mercy of
  // browser history/fullscreen-nav.js's own back interception - see
  // views/admin-events-registrations.ejs's own comment. A later real
  // request: "remove back to all events button. edit event should just
  // be a blue text link with back arrow on its own row. add
  // registration, print, export, import buttons should all be on their
  // own row below/stacked under the edit event link" - removes the "All
  // Events" button entirely and moves "Edit Event" to its own plain-link
  // row above the action-button row, same convention as admin-events-
  // builder.ejs's own "All Events" link.
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin);
  await publishEvent(admin, eventId);

  const res = await request(app).get(`/main-admin/events/${eventId}/registrations`).set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /All Events/);
  assert.match(res.text, new RegExp(`<p><a href="/main-admin/events/${eventId}/builder">&larr; Edit Event</a></p>`));

  const linkIndex = res.text.indexOf('&larr; Edit Event');
  const btnRowIndex = res.text.indexOf('+ Add Registration');
  assert.ok(linkIndex > -1 && btnRowIndex > linkIndex, 'the Edit Event link row should come before the action button row');
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

// A real request: "allow waiting list signups (only applicable when Max
// Allowed is reached)" - when off, a full event rejects a new
// registration outright instead of waitlisting it.
test('capacity full + waitlist signups disabled: registration is rejected, not waitlisted', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { title: 'No Waitlist Workshop', visibility: 'public', capacityValue: '1', capacityType: 'person' });
  await publishEvent(admin, eventId);
  await db.prepare('UPDATE events SET allow_waitlist_signups = 0 WHERE id = ?').run(eventId);

  const parent = await createParentAccount(1);
  const child = parent.familyMemberIds[0];

  const first = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: parent.csrfToken });
  assert.match(first.headers.location, /notice=/);

  const second = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(child), _csrf: parent.csrfToken });
  assert.match(decodeURIComponent(second.headers.location), /error=.*full.*not accepting waitlist/i);

  const rows = await db.prepare('SELECT member_id, status FROM event_registrations WHERE event_id = ?').all(eventId);
  assert.equal(rows.length, 1, 'the second, over-capacity registration should never have been created');
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

// A real request: "event editing under details add another text box that
// says activity information, another text box below that saying meetup
// and parking information, another text box under that saying what to
// bring. Under that a text box that says extra notes. Next to each of
// these title is a check box and question that says include this
// section? If the box is checked then the information filled out and the
// section will appear on the event for members to see."
test('Event Details: four optional info sections (Activity Information/Meetup & Parking/What to Bring/Extra Notes), each gated by its own "Include this section?" checkbox', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public' });

  const builderPage = await request(app).get(`/main-admin/events/${eventId}/builder?tab=details`).set('Cookie', admin.cookie);
  assert.match(builderPage.text, /Activity Information[\s\S]*?Include this section\?/);
  assert.match(builderPage.text, /Meetup and Parking Information[\s\S]*?Include this section\?/);
  assert.match(builderPage.text, /What to Bring[\s\S]*?Include this section\?/);
  assert.match(builderPage.text, /Extra Notes[\s\S]*?Include this section\?/);
  assert.match(builderPage.text, /<textarea name="activityInfo"/);
  assert.match(builderPage.text, /<textarea name="meetupParkingInfo"/);
  assert.match(builderPage.text, /<textarea name="whatToBring"/);
  assert.match(builderPage.text, /<textarea name="extraNotes"/);

  await request(app)
    .post(`/main-admin/events/${eventId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      title: 'Fall Picnic',
      startsAt: '2027-09-01T18:00',
      activityInfo: 'Bring your own blanket and enjoy games in the field.',
      includeActivityInfo: '1',
      meetupParkingInfo: 'Park in the north lot and meet by the flagpole.',
      // includeMeetupParkingInfo intentionally omitted - box unchecked.
      whatToBring: 'Sunscreen and a water bottle.',
      includeWhatToBring: '1',
      _csrf: admin.csrfToken,
    });

  const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(event.activity_info, 'Bring your own blanket and enjoy games in the field.');
  assert.equal(Number(event.include_activity_info), 1);
  assert.equal(Number(event.include_meetup_parking_info), 0);
  assert.equal(event.what_to_bring, 'Sunscreen and a water bottle.');
  assert.equal(Number(event.include_what_to_bring), 1);
  assert.equal(event.extra_notes, null);
  assert.equal(Number(event.include_extra_notes), 0);

  await publishEvent(admin, eventId);
  const parent = await createParentAccount();
  const detailPage = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(detailPage.status, 200);
  assert.match(detailPage.text, /Activity Information/);
  assert.match(detailPage.text, /Bring your own blanket and enjoy games in the field\./);
  assert.match(detailPage.text, /What to Bring/);
  assert.match(detailPage.text, /Sunscreen and a water bottle\./);
  // Meetup and Parking Information has text but its checkbox is off - must
  // not show, proving the checkbox (not just having text) gates display.
  assert.doesNotMatch(detailPage.text, /Meetup and Parking Information/);
  assert.doesNotMatch(detailPage.text, /Park in the north lot/);
  // Extra Notes has neither text nor its checkbox on - must not show.
  assert.doesNotMatch(detailPage.text, /Extra Notes/);
});

// A real request: "clicking on an event to register. If the event starts
// and ends the same day we only need to see one date. Time should be
// stacked under date with a clock icon. Location should be stacked under
// time."
test('Public event detail page: same-day event shows one date, stacked time (with clock icon) and location', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public', startsAt: '2027-09-01T18:00', endsAt: '2027-09-01T20:00', location: 'Main Hall' });
  await publishEvent(admin, eventId);

  const page = await request(app).get(`/events/${eventId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /event-hero-meta-stack/);
  // One date line for the date, not a range, since both ends land on the
  // same Eastern-zoned calendar day.
  assert.match(page.text, /<use href="#icon-calendar-check"\/><\/svg> September 1, 2027<\/p>/);
  assert.match(page.text, /<use href="#icon-clock"\/><\/svg> 2:00pm – 4:00pm<\/p>/);
  assert.match(page.text, /<use href="#icon-map-pin"\/><\/svg> Main Hall<\/p>/);
});

test('Public event detail page: a multi-day event shows a date range', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public', startsAt: '2027-09-01T18:00', endsAt: '2027-09-02T10:00' });
  await publishEvent(admin, eventId);

  const page = await request(app).get(`/events/${eventId}`);
  assert.match(page.text, /September 1, 2027 – September 2, 2027/);
});

// A real request: "Name of each member should not be on each button. It
// should be a list of members with a small register button next to each
// name in a clean column. It will gray out member who are not of the age
// or grade to register."
test('Public event detail page: Register list is a clean column (no name-on-button), grays out members outside the age restriction', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public' });
  await publishEvent(admin, eventId);

  // Lock the event to age 8 only.
  await db.prepare('UPDATE events SET lock_registration_to_age = 1, age_group_restriction = ? WHERE id = ?').run('8', eventId);

  const parent = await createParentAccount(1);
  const childId = parent.familyMemberIds[0];
  const thisYear = new Date().getUTCFullYear();
  // Parent gets an adult birthday (ineligible - not age 8); child gets a
  // birthday landing exactly on age 8 (eligible).
  await db.prepare('UPDATE members SET birthday = ? WHERE id = ?').run(`${thisYear - 40}-01-01`, parent.memberId);
  await db.prepare('UPDATE members SET birthday = ? WHERE id = ?').run(`${thisYear - 8}-01-01`, childId);

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /event-register-member-list/);
  // Neither button carries the member's own name in its own text.
  assert.doesNotMatch(page.text, /: Register</);
  assert.match(page.text, /class="event-register-member-row event-register-member-row-ineligible"/);
  // The ineligible row shows "Not eligible" instead of a Register button.
  const rowsSection = page.text.slice(page.text.indexOf('event-register-member-list'));
  assert.match(rowsSection, /Not eligible/);
  assert.match(rowsSection, /roster-action-btn-small js-event-register-btn">Register</);

  // The eligible child can still actually register (server-side gate
  // agrees with what the page showed as clickable).
  const csrfToken = extractCsrf(page.text);
  const res = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(childId), _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.doesNotMatch(res.headers.location, /error=/);

  // The ineligible parent is rejected server-side too, not just hidden.
  const rejected = await request(app)
    .post(`/events/${eventId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), _csrf: csrfToken });
  assert.match(decodeURIComponent(rejected.headers.location), /limited to specific ages/);
});

// A real request: "event details at top should show grades and/or ages
// selected for the event. If none are selected it will say all ages."
test('Public event detail page: header shows "All ages" with no restriction, and the actual grades/ages once locked', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public' });
  await publishEvent(admin, eventId);

  const noLockPage = await request(app).get(`/events/${eventId}`);
  assert.match(noLockPage.text, /All ages/);

  await db.prepare('UPDATE events SET lock_registration_to_grade = 1, age_group = ? WHERE id = ?').run('K, 1st', eventId);
  const gradeLockPage = await request(app).get(`/events/${eventId}`);
  assert.match(gradeLockPage.text, /Grades: K, 1st/);
  assert.doesNotMatch(gradeLockPage.text, /All ages/);

  await db.prepare('UPDATE events SET lock_registration_to_age = 1, age_group_restriction = ? WHERE id = ?').run('5, 6', eventId);
  const bothLocksPage = await request(app).get(`/events/${eventId}`);
  assert.match(bothLocksPage.text, /Grades: K, 1st/);
  assert.match(bothLocksPage.text, /Ages: 5, 6/);

  // A lock switched on with nothing actually picked lets everyone through
  // (ageGroupAllowsMember/ageBucketAllowsMember's own fallback) - the
  // summary must agree and still say "All ages", not falsely claim a
  // restriction nobody would actually hit.
  await db.prepare('UPDATE events SET age_group = ?, age_group_restriction = ? WHERE id = ?').run('', '', eventId);
  const emptyListsPage = await request(app).get(`/events/${eventId}`);
  assert.match(emptyListsPage.text, /All ages/);
});

// A real request: "when showing all members that are registered for event
// it should be organized by family. Click on family to expand and show
// more members of that family that are registered."
test('Public event detail page: Who\'s Registered groups a family behind a "+N more" expander, and leaves a solo registrant alone', async () => {
  const admin = await loginAsMainAdmin();
  const eventId = await createEvent(admin, { visibility: 'public' });
  await db.prepare('UPDATE events SET show_registrants_to_members = 1 WHERE id = ?').run(eventId);
  await publishEvent(admin, eventId);

  const family = await createParentAccount(1);
  const familyChildId = family.familyMemberIds[0];
  const familyParentName = (await db.prepare('SELECT name FROM members WHERE id = ?').get(family.memberId)).name;
  const familyChildName = (await db.prepare('SELECT name FROM members WHERE id = ?').get(familyChildId)).name;
  await request(app).post(`/events/${eventId}/register`).set('Cookie', family.cookie).type('form').send({ memberId: String(family.memberId), _csrf: family.csrfToken });
  await request(app).post(`/events/${eventId}/register`).set('Cookie', family.cookie).type('form').send({ memberId: String(familyChildId), _csrf: family.csrfToken });

  const solo = await createParentAccount(0);
  const soloName = (await db.prepare('SELECT name FROM members WHERE id = ?').get(solo.memberId)).name;
  await request(app).post(`/events/${eventId}/register`).set('Cookie', solo.cookie).type('form').send({ memberId: String(solo.memberId), _csrf: solo.csrfToken });

  const page = await request(app).get(`/events/${eventId}`).set('Cookie', solo.cookie);
  assert.match(page.text, /<h3>Who's Registered<\/h3>/);
  // The 2-person family collapses behind a <details> "+1 more" expander,
  // with its own second member only inside the nested, initially-closed list.
  const familyBlockRegex = new RegExp(
    `<details class="event-registrant-family">\\s*<summary>${familyParentName} <span class="hint">\\+1 more</span></summary>\\s*<ul class="portal-dashboard-list">\\s*<li>${familyChildName}</li>`
  );
  assert.match(page.text, familyBlockRegex);
  // The solo registrant (nothing else in their group) is a plain list
  // item, not wrapped in its own <details>/expander.
  assert.match(page.text, new RegExp(`<li>${soloName}</li>`));
  assert.doesNotMatch(page.text, new RegExp(`<summary>${soloName}`));
});

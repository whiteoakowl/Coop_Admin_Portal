// Coverage for a real request: "Add the same exact check box and button
// system on floater assignments, on each setup cleanup team and
// position." Mirrors test/routes-admin-volunteers-floater-text-notify.test.js
// exactly - GET /assignments renders a checkbox per assigned member, and
// POST /setup-text-notify actually sends, routing through notify()
// (utils/notifications.js) so SMS opt-out preferences are respected the
// same way any other notification type's are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-text-notify-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-text-notify-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.TELNYX_API_KEY = 'test-key';
process.env.TELNYX_FROM_NUMBER = '+15555550123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

function futureMonday() {
  let d = addDays(todayISO(), 21);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let savedFetch;
test.beforeEach(() => {
  savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { id: 'msg_test' } }) });
});
test.afterEach(() => {
  global.fetch = savedFetch;
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

// Creates a team with one task-list item, enrolls a member, adds the
// session date, and assigns the member that one task (slot 1) - the
// minimal "a member has at least one task assigned" shape the checkbox
// itself only ever shows for (see setup-assignment-cards.ejs's own
// comment).
async function setUpAssignedTeamMember({ cookie, teamTitle, taskDescription, memberName, barcode, phone }) {
  const day = 'monday';
  const date = futureMonday();
  const team = await db.prepare('INSERT INTO setup_teams (day, title) VALUES (?, ?)').run(day, teamTitle);
  const section = await db.prepare('INSERT INTO task_list_sections (day, title, team_id, position) VALUES (?, ?, ?, 0)').run(day, `${teamTitle} Tasks`, team.lastInsertRowid);
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, taskDescription);
  const member = await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES (?, ?, 'parent', ?)").run(memberName, barcode, phone || null);

  const page = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  await request(app)
    .post(`/admin/setup/${day}/dates/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: date, _csrf: csrfToken });

  await request(app)
    .post(`/admin/setup/${day}/assignments/${member.lastInsertRowid}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, taskItemId: String(item.lastInsertRowid), _csrf: csrfToken });

  return { memberId: member.lastInsertRowid, day, date, teamId: team.lastInsertRowid, teamTitle, taskDescription };
}

test('GET /assignments renders a checkbox for a member with an assigned task (none for an unassigned one), a Select All checkbox, and a Send Text button for that team', async () => {
  const cookie = await loginAsAdmin();
  const { day, date } = await setUpAssignedTeamMember({ cookie, teamTitle: 'Checkbox Crew', taskDescription: 'Wipe counters', memberName: 'Checkbox Member', barcode: 'notify-checkbox-setup-member', phone: '555-222-3333' });

  const page = await request(app).get(`/admin/setup/${day}/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /floater-notify-checkbox/);
  assert.match(page.text, /data-member-id="\d+"/);
  assert.match(page.text, /data-team="Checkbox Crew"/);
  assert.match(page.text, /data-tasks="Wipe counters"/);
  // Every team with at least one member who has a task assigned also
  // gets its own Select All checkbox and Send Text button, same as
  // Floater Assignments' own per-hour card.
  assert.match(page.text, /floater-card-select-all-checkbox/);
  assert.match(page.text, /class="floater-card-send-text-btn no-print" disabled/);
});

test('GET /assignments shows no checkbox, Select All, or Send Text for a team with no member yet assigned a task', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const date = futureMonday();
  const team = await db.prepare('INSERT INTO setup_teams (day, title) VALUES (?, ?)').run(day, 'Unassigned Crew');
  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unassigned Member', 'notify-unassigned-member', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  const page = await request(app).get(`/admin/setup/${day}/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  // Other tests in this file create their own teams on the same day, so
  // isolate this one team's own card (from its title through its own
  // footer) rather than asserting against the whole page, which may
  // also contain an earlier test's own assigned team (and its own
  // Select All/Send Text controls).
  const cardMatch = new RegExp('<h3>Unassigned Crew</h3>[\\s\\S]*?floater-card-footer[\\s\\S]*?</div>\\s*</div>').exec(page.text);
  assert.ok(cardMatch, 'expected to find the Unassigned Crew card');
  assert.doesNotMatch(cardMatch[0], /floater-card-select-all-checkbox/);
  assert.doesNotMatch(cardMatch[0], /floater-card-send-text-btn/);
});

test('POST /setup-text-notify texts an assigned team member with an active portal account, routed through notify()', async () => {
  const cookie = await loginAsAdmin();
  const { day, memberId } = await setUpAssignedTeamMember({ cookie, teamTitle: 'Send Crew', taskDescription: 'Sweep floors', memberName: 'Sendable Member', barcode: 'notify-send-setup-member', phone: '555-444-5555' });
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'sendable-setup-member@example.com', 'x', 'active')").run(memberId);

  const page = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/setup/${day}/assignments/setup-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned to Send Crew: Sweep floors.");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sentCount, 1);
  assert.equal(res.body.results[0].status, 'sent');

  const notification = await db.prepare("SELECT title, body FROM notifications WHERE type_key = 'setup_cleanup_assignment' ORDER BY id DESC LIMIT 1").get();
  assert.ok(notification, 'expected a setup_cleanup_assignment notification row to be created');
  assert.equal(notification.body, "You're assigned to Send Crew: Sweep floors.");
});

test('POST /setup-text-notify requires a message for a single recipient', async () => {
  const cookie = await loginAsAdmin();
  const { day, memberId } = await setUpAssignedTeamMember({ cookie, teamTitle: 'No Message Crew', taskDescription: 'Stack chairs', memberName: 'No Message Member', barcode: 'notify-no-message-setup-member', phone: '555-111-2222' });

  const page = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/setup/${day}/assignments/setup-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', '');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

// A real request: same no-portal-account fallback Floater Assignments'
// own text notify already has - "that shouldn't matter," so this
// mirrors it directly for Setup/Cleanup too.
test('POST /setup-text-notify texts a member with no portal account on file, straight off their phone number', async () => {
  const cookie = await loginAsAdmin();
  const { day, memberId } = await setUpAssignedTeamMember({ cookie, teamTitle: 'No Account Crew', taskDescription: 'Empty trash', memberName: 'No Account Member', barcode: 'notify-no-account-setup-member', phone: '555-666-7777' });

  const page = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/setup/${day}/assignments/setup-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned to No Account Crew: Empty trash.");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sentCount, 1);
  assert.equal(res.body.results[0].status, 'sent');

  const notification = await db.prepare("SELECT * FROM notifications WHERE type_key = 'setup_cleanup_assignment' AND body = ?").get("You're assigned to No Account Crew: Empty trash.");
  assert.equal(notification, undefined);
});

// A real request: "if sending a text to everyone assigned that hour it
// should not allow you to customize the message and it should send each
// member their own unique assigned assignment" - same rule carried over
// for Setup/Cleanup: 2+ recipients each get their own message built
// server-side from their own team/tasks, never the shared message field.
test('POST /setup-text-notify with 2+ recipients ignores any message field and builds each one their own templated message', async () => {
  const cookie = await loginAsAdmin();
  const first = await setUpAssignedTeamMember({ cookie, teamTitle: 'Multi Crew A', taskDescription: 'Fold tables', memberName: 'Multi Member A', barcode: 'notify-multi-setup-member-a', phone: '555-111-0001' });
  const second = await setUpAssignedTeamMember({ cookie, teamTitle: 'Multi Crew B', taskDescription: 'Mop floors', memberName: 'Multi Member B', barcode: 'notify-multi-setup-member-b', phone: '555-111-0002' });
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'multi-setup-a@example.com', 'x', 'active')").run(first.memberId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'multi-setup-b@example.com', 'x', 'active')").run(second.memberId);

  const page = await request(app).get(`/admin/setup/${first.day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/setup/${first.day}/assignments/setup-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([
      { memberId: String(first.memberId), team: 'Multi Crew A', tasks: 'Fold tables' },
      { memberId: String(second.memberId), team: 'Multi Crew B', tasks: 'Mop floors' },
    ]))
    .field('message', 'This shared message should be ignored entirely.');

  assert.equal(res.status, 200);
  assert.equal(res.body.sentCount, 2);

  const notifA = await db.prepare("SELECT body FROM notifications WHERE type_key = 'setup_cleanup_assignment' AND member_account_id = (SELECT id FROM member_accounts WHERE member_id = ?)").get(first.memberId);
  const notifB = await db.prepare("SELECT body FROM notifications WHERE type_key = 'setup_cleanup_assignment' AND member_account_id = (SELECT id FROM member_accounts WHERE member_id = ?)").get(second.memberId);
  assert.ok(notifA);
  assert.ok(notifB);
  assert.doesNotMatch(notifA.body, /shared message/);
  assert.doesNotMatch(notifB.body, /shared message/);
  assert.match(notifA.body, /Fold tables/);
  assert.match(notifB.body, /Mop floors/);
  assert.notEqual(notifA.body, notifB.body);
});

test('POST /setup-text-notify respects a member who opted out of setup_cleanup_assignment SMS notifications', async () => {
  const cookie = await loginAsAdmin();
  const { day, memberId } = await setUpAssignedTeamMember({ cookie, teamTitle: 'Opted Out Crew', taskDescription: 'Vacuum carpets', memberName: 'Opted Out Member', barcode: 'notify-opted-out-setup-member', phone: '555-888-9999' });
  const { lastInsertRowid: accountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'opted-out-setup-member@example.com', 'x', 'active')")
    .run(memberId);
  await db
    .prepare('INSERT INTO notification_preferences (member_account_id, type_key, channel, enabled) VALUES (?, ?, ?, ?)')
    .run(accountId, 'setup_cleanup_assignment', 'sms', 0);

  const page = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/setup/${day}/assignments/setup-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned to Opted Out Crew: Vacuum carpets.");

  assert.equal(res.status, 200);
  assert.equal(res.body.sentCount, 0);
  assert.equal(res.body.results[0].status, 'skipped');
  assert.match(res.body.results[0].detail, /opted out/i);
});

// Coverage for a real request: "On floater assignments page. Add a
// button that says text notification. When you click this button a
// check box appears next to each floater assignment. When you click
// the check boxes then click text notifications. It send a notification
// showing the floater position, hour and room number." A later real
// request removed that page-level button: "Not [the] orange send text
// button at the top... Just the send text buttons on each hour title
// bar. Select all assigned floaters by clicking the check box on the
// title bars or select individual rows to send notifications to that
// hour then click send text." The checkboxes/Send Text buttons are a
// client-only concern (public/js/floater-text-notify.js) - this covers
// the server side: GET /manage renders a checkbox per assigned slot,
// and POST /floater-text-notify actually sends, routing through
// notify() (utils/notifications.js) so SMS opt-out preferences are
// respected the same way any other notification type's are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-floater-notify-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-floater-notify-test-uploads-${process.pid}`);
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
const { createClass } = require('../utils/classSchedule');

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

function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + (((1 - d.getDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function setUpAssignedFloater({ cookie, day, hourPosition, className, room, memberName, barcode, phone }) {
  const classId = await createClass({ day, hourPosition, className, room, assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES (?, ?, 'parent', ?)")
    .run(memberName, barcode, phone || null);
  const date = nextMonday();
  const { classVacancySlotId } = require('../utils/substitutes');
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  // substituteBoard only surfaces slots for dates the list's own active
  // dates actually cover - same reasoning routes-admin-substitutes-
  // fetch-assign.test.js's own /fragment test already documents.
  await request(app)
    .post(`/admin/volunteers/${day}/dates/add?dialog=dates`)
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: date, _csrf: csrfToken });

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  return { memberId, date, classId, slotId };
}

test('GET /manage renders a checkbox for an assigned floater slot (none for an unassigned one), a Select All checkbox, and a Send Text button for that hour', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { date } = await setUpAssignedFloater({ cookie, day, hourPosition: 1, className: 'Notify Checkbox Class', room: 'Room 9', memberName: 'Checkbox Floater', barcode: 'notify-checkbox-floater', phone: '555-222-3333' });

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  // A real request removed the page-level toggle button entirely:
  // "Not [the] orange send text button at the top... Just the send
  // text buttons on each hour title bar."
  assert.doesNotMatch(page.text, /id="floater-text-notify-btn"/);
  assert.match(page.text, /floater-notify-checkbox/);
  assert.match(page.text, /data-member-id="\d+"/);
  // A real request: "click the check boxes on each assignment or the
  // whole card" - every hour with at least one assigned slot also gets
  // its own Select All checkbox.
  assert.match(page.text, /floater-card-select-all-checkbox/);
  // A later real request: "Send text button on hour title bar, shrink
  // to fit" - same hour gets its own Send Text button, disabled until
  // something in that card is checked.
  assert.match(page.text, /class="floater-card-send-text-btn no-print" disabled/);
});

test('POST /floater-text-notify texts an assigned floater with an active portal account, routed through notify()', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { memberId } = await setUpAssignedFloater({ cookie, day, hourPosition: 2, className: 'Notify Send Class', room: 'Room 12', memberName: 'Sendable Floater', barcode: 'notify-send-floater', phone: '555-444-5555' });
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'sendable-floater@example.com', 'x', 'active')").run(memberId);

  const page = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  // multipart/form-data now (not JSON) - the optional image rides along
  // as a real file upload (public/js/floater-text-notify.js's own
  // popup), and the message is whatever the admin typed/edited in that
  // popup, not server-built from position/room/hour any more.
  const res = await request(app)
    .post(`/admin/volunteers/${day}/floater-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned: Assistant at 9:00 AM in Room 12.");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sentCount, 1);
  assert.equal(res.body.results[0].status, 'sent');

  const notification = await db.prepare("SELECT title, body FROM notifications WHERE type_key = 'floater_assignment' ORDER BY id DESC LIMIT 1").get();
  assert.ok(notification, 'expected a floater_assignment notification row to be created');
  assert.equal(notification.body, "You're assigned: Assistant at 9:00 AM in Room 12.");
});

test('POST /floater-text-notify requires a message for a single recipient', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { memberId } = await setUpAssignedFloater({ cookie, day, hourPosition: 5, className: 'No Message Class', room: 'Room 5', memberName: 'No Message Floater', barcode: 'notify-no-message-floater', phone: '555-111-2222' });
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'no-message-floater@example.com', 'x', 'active')").run(memberId);

  const page = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/volunteers/${day}/floater-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', '');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

// A real request: "Floater assignments won't send text because it
// says the member is not assigned to a portal. That shouldn't matter."
// A floater with no member_accounts row at all now texts directly off
// their own members.phone (smsProvider.send(), mocked to succeed in
// this file's own beforeEach) instead of being skipped.
test('POST /floater-text-notify texts a floater with no portal account on file, straight off their phone number', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { memberId } = await setUpAssignedFloater({ cookie, day, hourPosition: 3, className: 'No Account Class', room: 'Room 3', memberName: 'No Account Floater', barcode: 'notify-no-account-floater', phone: '555-666-7777' });

  const page = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/volunteers/${day}/floater-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned: Assistant at 10:00 AM in Room 3.");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sentCount, 1);
  assert.equal(res.body.results[0].status, 'sent');

  // No member_accounts row means notify() never ran for this member,
  // so there's no in-app Notification Center entry either - the send
  // happened straight through smsProvider, not through notify(). This
  // test's own message text is unique across the whole file, so it's
  // a safe stand-in for "a notification this specific send would have
  // created" without needing to join back through a nonexistent account.
  const notification = await db.prepare("SELECT * FROM notifications WHERE type_key = 'floater_assignment' AND body = ?").get("You're assigned: Assistant at 10:00 AM in Room 3.");
  assert.equal(notification, undefined);
});

// A real request: "if sending a text to everyone assigned that hour
// it should not allow you to customize the message and it should send
// each member their own unique assigned assignment." Each recipient's
// own message is built server-side from the admin-editable template
// (floater_assignment_default), filled with THEIR OWN position/room/
// hour - a shared req.body.message is only honored for a single
// recipient.
test('POST /floater-text-notify with 2+ recipients ignores any message field and builds each one their own templated message', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const first = await setUpAssignedFloater({ cookie, day, hourPosition: 6, className: 'Multi Send Class A', room: 'Room 6', memberName: 'Multi Send Floater A', barcode: 'notify-multi-floater-a', phone: '555-111-0001' });
  const second = await setUpAssignedFloater({ cookie, day, hourPosition: 7, className: 'Multi Send Class B', room: 'Room 7', memberName: 'Multi Send Floater B', barcode: 'notify-multi-floater-b', phone: '555-111-0002' });
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'multi-send-a@example.com', 'x', 'active')").run(first.memberId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'multi-send-b@example.com', 'x', 'active')").run(second.memberId);

  const page = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/volunteers/${day}/floater-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([
      { memberId: String(first.memberId), position: 'Assistant', room: 'Room 6', hour: '1:00 PM' },
      { memberId: String(second.memberId), position: 'Assistant', room: 'Room 7', hour: '2:00 PM' },
    ]))
    .field('message', 'This shared message should be ignored entirely.');

  assert.equal(res.status, 200);
  assert.equal(res.body.sentCount, 2);

  const notifA = await db.prepare("SELECT body FROM notifications WHERE type_key = 'floater_assignment' AND member_account_id = (SELECT id FROM member_accounts WHERE member_id = ?)").get(first.memberId);
  const notifB = await db.prepare("SELECT body FROM notifications WHERE type_key = 'floater_assignment' AND member_account_id = (SELECT id FROM member_accounts WHERE member_id = ?)").get(second.memberId);
  assert.ok(notifA);
  assert.ok(notifB);
  assert.doesNotMatch(notifA.body, /shared message/);
  assert.doesNotMatch(notifB.body, /shared message/);
  assert.match(notifA.body, /Room 6/);
  assert.match(notifB.body, /Room 7/);
  assert.notEqual(notifA.body, notifB.body);
});

test('POST /floater-text-notify respects a member who opted out of floater_assignment SMS notifications', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { memberId } = await setUpAssignedFloater({ cookie, day, hourPosition: 4, className: 'Opted Out Class', room: 'Room 4', memberName: 'Opted Out Floater', barcode: 'notify-opted-out-floater', phone: '555-888-9999' });
  const { lastInsertRowid: accountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'opted-out-floater@example.com', 'x', 'active')")
    .run(memberId);
  await db
    .prepare('INSERT INTO notification_preferences (member_account_id, type_key, channel, enabled) VALUES (?, ?, ?, ?)')
    .run(accountId, 'floater_assignment', 'sms', 0);

  const page = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/volunteers/${day}/floater-text-notify`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('notify', JSON.stringify([{ memberId: String(memberId) }]))
    .field('message', "You're assigned: Assistant at 11:00 AM in Room 4.");

  assert.equal(res.status, 200);
  assert.equal(res.body.sentCount, 0);
  assert.equal(res.body.results[0].status, 'skipped');
  assert.match(res.body.results[0].detail, /opted out/i);
});

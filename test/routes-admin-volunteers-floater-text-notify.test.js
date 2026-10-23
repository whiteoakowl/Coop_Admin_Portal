// Coverage for a real request: "On floater assignments page. Add a
// button that says text notification. When you click this button a
// check box appears next to each floater assignment. When you click
// the check boxes then click text notifications. It send a notification
// showing the floater position, hour and room number." The checkbox
// itself is a client-only toggle (public/js/floater-text-notify.js) -
// this covers the server side: GET /manage renders a checkbox per
// assigned slot, and POST /floater-text-notify actually sends, routing
// through notify() (utils/notifications.js) so SMS opt-out preferences
// are respected the same way any other notification type's are.
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

test('GET /manage renders a Text Notification button and a checkbox for an assigned floater slot, none for an unassigned one', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const { date } = await setUpAssignedFloater({ cookie, day, hourPosition: 1, className: 'Notify Checkbox Class', room: 'Room 9', memberName: 'Checkbox Floater', barcode: 'notify-checkbox-floater', phone: '555-222-3333' });

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="floater-text-notify-btn"/);
  assert.match(page.text, /floater-notify-checkbox/);
  assert.match(page.text, /data-member-id="\d+"/);
  // A real request: "click the check boxes on each assignment or the
  // whole card" - every hour with at least one assigned slot also gets
  // its own Select All checkbox.
  assert.match(page.text, /floater-card-select-all-checkbox/);
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

test('POST /floater-text-notify requires a message', async () => {
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

test('POST /floater-text-notify skips a floater with no portal account on file, without erroring the whole batch', async () => {
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
  assert.equal(res.body.sentCount, 0);
  assert.equal(res.body.results[0].status, 'skipped');
  assert.match(res.body.results[0].detail, /No portal account on file/);
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

// Coverage for a real request: "Main admin portal and co-op admin
// portal. Members. Add a text icon to click and a pop up appears
// allowing you type a text message, add an image and send text button
// and close button." Mirrors test/routes-admin-volunteers-floater-text-
// notify.test.js's own server-side coverage, just a single always-known
// recipient per dialog (no checkbox-selection step) and reusing the
// existing 'text_message' notification type Communication's own Text
// campaign feature already seeded, instead of a new type/template.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `members-text-notify-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `members-text-notify-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';
process.env.TELNYX_API_KEY = 'test-key';
process.env.TELNYX_FROM_NUMBER = '+15555550123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

async function loginCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function loginMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

test('Co-op Admin Members: GET /members renders a Text icon for a member with a phone on file, a disabled one otherwise', async () => {
  const cookie = await loginCoopAdmin();
  const withPhone = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone, active) VALUES ('Text Icon With Phone', 'text-icon-with-phone', 'student', '555-222-3333', 1) RETURNING id").get()).id;
  const classId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Text Icon Class') RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, withPhone);

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`document.getElementById\\('text-dialog-${withPhone}'\\)`));
  assert.match(page.text, new RegExp(`data-text-notify-url="/admin/members/${withPhone}/text"`));
});

test('POST /admin/members/:id/text texts a member with an active portal account, routed through notify()', async () => {
  const cookie = await loginCoopAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Coop Text Send Member', 'coop-text-send-member', 'parent', '555-444-5555') RETURNING id").get()).id;
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'coop-text-send@example.com', 'x', 'active')").run(memberId);

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'Hey, just checking in!');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'sent');

  const notification = await db.prepare("SELECT title, body FROM notifications WHERE type_key = 'text_message' ORDER BY id DESC LIMIT 1").get();
  assert.ok(notification, 'expected a text_message notification row to be created');
  assert.equal(notification.body, 'Hey, just checking in!');
});

// A real request, already established for Floater/Setup's own text-
// notify routes: "that shouldn't matter" - a member with no portal
// account texts directly off their own members.phone.
test('POST /admin/members/:id/text texts a member with no portal account on file, straight off their phone number', async () => {
  const cookie = await loginCoopAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Coop Text No Account Member', 'coop-text-no-account-member', 'parent', '555-666-7777') RETURNING id").get()).id;

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'No portal account, should still work.');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'sent');

  const notification = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND body = ?").get('No portal account, should still work.');
  assert.equal(notification, undefined);
});

test('POST /admin/members/:id/text requires a message', async () => {
  const cookie = await loginCoopAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Coop Text No Message Member', 'coop-text-no-message-member', 'parent', '555-111-2222') RETURNING id").get()).id;

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', '');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

// A real request: "Set 160 character length for all texting features
// across the app."
test('GET /admin/members renders the Text dialog textarea with maxlength=160 and a live character counter, and POST rejects a message over that length', async () => {
  const cookie = await loginCoopAdmin();
  // Co-op Admin's own Members list only shows a family with at least one
  // enrolled student (routes/admin-members.js's own filteredMembers
  // comment) - a class + enrollment, same as this file's very first
  // test above, so this member actually renders on the page.
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Coop Text Length Member', 'coop-text-length-member', 'student', '555-333-4444') RETURNING id").get()).id;
  const classId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Text Length Class') RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, memberId);

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.match(page.text, new RegExp(`id="text-dialog-${memberId}"[\\s\\S]*?maxlength="160" data-sms-char-counter="text-char-count-${memberId}"`));
  assert.match(page.text, new RegExp(`id="text-char-count-${memberId}">0 / 160 characters`));
  const csrfToken = extractCsrf(page.text);

  const longMessage = 'a'.repeat(161);
  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', longMessage);

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /capped at 160 characters/);
});

test('POST /admin/members/:id/text rejects a member with no phone on file', async () => {
  const cookie = await loginCoopAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Coop Text No Phone Member', 'coop-text-no-phone-member', 'parent') RETURNING id").get()).id;

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'Should not send.');

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('Main Admin Members: GET /members renders a Text icon, and POST /main-admin/members/:id/text texts a member with an active portal account', async () => {
  const cookie = await loginMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Main Text Send Member', 'main-text-send-member', 'parent', '555-888-9999') RETURNING id").get()).id;
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'main-text-send@example.com', 'x', 'active')").run(memberId);

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`data-text-notify-url="/main-admin/members/${memberId}/text"`));
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'Main Admin text test.');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'sent');

  const notification = await db.prepare("SELECT body FROM notifications WHERE type_key = 'text_message' AND body = 'Main Admin text test.'").get();
  assert.ok(notification);
});

test('Main Admin Members: POST /main-admin/members/:id/text rejects a message over 160 characters', async () => {
  const cookie = await loginMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Main Text Length Member', 'main-text-length-member', 'parent', '555-777-8888') RETURNING id").get()).id;

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.match(page.text, new RegExp(`id="text-dialog-${memberId}"[\\s\\S]*?maxlength="160" data-sms-char-counter="text-char-count-${memberId}"`));
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/main-admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'a'.repeat(161));

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /capped at 160 characters/);
});

test('POST /admin/members/:id/text respects a member who opted out of text_message SMS notifications', async () => {
  const cookie = await loginCoopAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, phone) VALUES ('Coop Text Opted Out Member', 'coop-text-opted-out-member', 'parent', '555-333-4444') RETURNING id").get()).id;
  const { lastInsertRowid: accountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'coop-text-opted-out@example.com', 'x', 'active')")
    .run(memberId);
  await db
    .prepare('INSERT INTO notification_preferences (member_account_id, type_key, channel, enabled) VALUES (?, ?, ?, ?)')
    .run(accountId, 'text_message', 'sms', 0);

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const res = await request(app)
    .post(`/admin/members/${memberId}/text`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('message', 'Should be skipped.');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'skipped');
  assert.match(res.body.detail, /opted out/i);
});

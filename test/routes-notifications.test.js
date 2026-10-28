// Route-level coverage for the SMS/notification framework (Community &
// Commerce track, item 11). See utils/notifications.js's own comments:
// notify() always creates the in-app notification (the Notification
// Center's own data), and only attempts email/sms when the type's own
// email_enabled/sms_enabled is on and the recipient hasn't opted out -
// there's no real SMS/email provider configured anywhere, so those channels
// always record status='skipped' (utils/smsProvider.js /
// utils/emailProvider.js), never a fake "sent".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `notifications-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `notifications-test-uploads-${process.pid}`);
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
const notifications = require('../utils/notifications');
const newsletterUtil = require('../utils/newsletter');

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

// Builds the full all-types checkbox body POST /main-admin/notifications/channels
// expects (every row's current text/email state), used below to flip
// exactly one type's one channel without disturbing the others.
async function fullChannelsBody(csrfToken, overrides = {}) {
  const types = await notifications.listTypes();
  const body = { _csrf: csrfToken };
  for (const t of types) {
    const key = `text_${t.key}`;
    if (key in overrides ? overrides[key] : t.sms_enabled) body[key] = '1';
    const emailKey = `email_${t.key}`;
    if (emailKey in overrides ? overrides[emailKey] : t.email_enabled) body[emailKey] = '1';
  }
  return body;
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, code, code, familyId);
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/notifications' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/notifications').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), accountId: accountInfo.lastInsertRowid, memberId: parentInfo.lastInsertRowid };
}

async function createPublishedEvent(admin) {
  const res = await request(app)
    .post('/main-admin/events')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Field Trip', description: 'Fun', startsAt: '2027-01-01T10:00', visibility: 'members', _csrf: admin.csrfToken });
  const eventId = /\/main-admin\/events\/(\d+)\/builder/.exec(res.headers.location)[1];
  await request(app).post(`/main-admin/events/${eventId}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'published', _csrf: admin.csrfToken });
  return eventId;
}

test('admin notifications requires sign-in', async () => {
  const res = await request(app).get('/main-admin/notifications');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('member notification center requires sign-in', async () => {
  const res = await request(app).get('/notifications');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('registering for an event notifies the registrant, in-app always and email skipped (no provider configured)', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();
  const eventId = await createPublishedEvent(admin);

  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: parent.memberId, _csrf: parent.csrfToken });

  const items = await notifications.listForAccount(parent.accountId);
  assert.equal(items.length, 1);
  assert.equal(items[0].type_key, 'event_registration');

  const deliveries = await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ?').all(items[0].id);
  const inApp = deliveries.find((d) => d.channel === 'in_app');
  const email = deliveries.find((d) => d.channel === 'email');
  assert.equal(inApp.status, 'sent');
  assert.equal(email.status, 'skipped');
  assert.match(email.detail, /No email provider configured/);
});

test('a forum reply notifies the thread starter, not the replier, and never notifies a self-reply', async () => {
  const admin = await loginAsMainAdmin();
  const starter = await createParentAccount();
  const replier = await createParentAccount();

  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'General Notify Test', scope: 'general', _csrf: admin.csrfToken });
  const categoryId = (await db.prepare("SELECT id FROM forum_categories WHERE name = 'General Notify Test'").get()).id;

  const threadRes = await request(app)
    .post(`/forums/${categoryId}/threads`)
    .set('Cookie', starter.cookie)
    .type('form')
    .send({ title: 'Hello', body: 'First post', _csrf: starter.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(threadRes.headers.location)[1];

  // Starter replying to their own thread should not self-notify.
  await request(app).post(`/forums/threads/${threadId}/posts`).set('Cookie', starter.cookie).type('form').send({ body: 'Still me', _csrf: starter.csrfToken });
  assert.equal((await notifications.listForAccount(starter.accountId)).length, 0);

  await request(app).post(`/forums/threads/${threadId}/posts`).set('Cookie', replier.cookie).type('form').send({ body: 'A reply', _csrf: replier.csrfToken });

  const starterItems = await notifications.listForAccount(starter.accountId);
  assert.equal(starterItems.length, 1);
  assert.equal(starterItems[0].type_key, 'forum_reply');
  assert.equal((await notifications.listForAccount(replier.accountId)).length, 0);
});

test('marking a notification read, and mark-all-read, both work', async () => {
  const parent = await createParentAccount();
  const id1 = await notifications.notify(parent.accountId, 'newsletter_sent', { title: 'Issue 1', body: 'Body' });
  const id2 = await notifications.notify(parent.accountId, 'newsletter_sent', { title: 'Issue 2', body: 'Body' });

  await request(app).post(`/notifications/${id1}/read`).set('Cookie', parent.cookie).type('form').send({ _csrf: parent.csrfToken });
  let unread = await notifications.listForAccount(parent.accountId, { unreadOnly: true });
  assert.equal(unread.length, 1);
  assert.equal(unread[0].id, id2);

  await request(app).post('/notifications/read-all').set('Cookie', parent.cookie).type('form').send({ _csrf: parent.csrfToken });
  unread = await notifications.listForAccount(parent.accountId, { unreadOnly: true });
  assert.equal(unread.length, 0);
});

test('a member opting out of email for one type is recorded as skipped, not attempted, while other types are unaffected', async () => {
  const parent = await createParentAccount();
  const types = await notifications.listTypes();
  // Mirrors what the real form submits: every OTHER type's boxes stay
  // checked (email/sms both '1'), only newsletter_sent's email box is
  // left unchecked.
  const payload = { _csrf: parent.csrfToken };
  for (const type of types) {
    payload[`email_${type.key}`] = type.key === 'newsletter_sent' ? '0' : '1';
    payload[`sms_${type.key}`] = '1';
  }
  await request(app).post('/notifications/preferences').set('Cookie', parent.cookie).type('form').send(payload);

  const optedOutId = await notifications.notify(parent.accountId, 'newsletter_sent', { title: 'Issue', body: 'Body' });
  const optedOutEmail = (await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel = ?').all(optedOutId, 'email'))[0];
  assert.equal(optedOutEmail.status, 'skipped');
  assert.match(optedOutEmail.detail, /opted out/);

  const stillOnId = await notifications.notify(parent.accountId, 'forum_reply', { title: 'Reply', body: 'Body' });
  const stillOnEmail = (await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel = ?').all(stillOnId, 'email'))[0];
  assert.equal(stillOnEmail.status, 'skipped');
  assert.match(stillOnEmail.detail, /No email provider configured/);
});

test('an email-only notification type (sms_enabled off) never attempts SMS, even when the recipient has not opted out of it', async () => {
  const parent = await createParentAccount();

  // Default preferences (no override saved) - SMS would normally be
  // attempted for any type, confirming this is genuinely the type-level
  // sms_enabled gate, not a leftover per-account opt-out from another test.
  const emailOnlyId = await notifications.notify(parent.accountId, 'forum_reply', { title: 'Reply', body: 'Someone replied.' });
  const emailOnlySms = (await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel = ?').all(emailOnlyId, 'sms'))[0];
  assert.equal(emailOnlySms.status, 'skipped');
  assert.match(emailOnlySms.detail, /email-only/);

  // floater_assignment stays SMS-capable - the whole point of that
  // feature is the text itself - so it hits smsProvider.send()'s own
  // normal skip reason (the test fixture account has no phone on file)
  // instead of the email-only gate above.
  const floaterId = await notifications.notify(parent.accountId, 'floater_assignment', { title: 'Floater Assignment', body: "You're assigned: Hallway Monitor." });
  const floaterSms = (await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? AND channel = ?').all(floaterId, 'sms'))[0];
  assert.equal(floaterSms.status, 'skipped');
  assert.doesNotMatch(floaterSms.detail, /email-only/);
});

test("turning a type's text and email channels both off stops email/sms but keeps the in-app notification", async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();

  const offBody = await fullChannelsBody(admin.csrfToken, { text_event_registration: false, email_event_registration: false });
  await request(app).post('/main-admin/notifications/channels').set('Cookie', admin.cookie).type('form').send(offBody);

  const eventId = await createPublishedEvent(admin);
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: parent.memberId, _csrf: parent.csrfToken });

  const items = await notifications.listForAccount(parent.accountId);
  assert.equal(items.length, 1);
  const deliveries = await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ?').all(items[0].id);
  assert.equal(deliveries.length, 3, 'in_app plus a skipped row for each of email/sms');
  assert.equal(deliveries.find((d) => d.channel === 'in_app').status, 'sent');
  assert.equal(deliveries.find((d) => d.channel === 'email').status, 'skipped');
  assert.equal(deliveries.find((d) => d.channel === 'sms').status, 'skipped');

  // Restore to event_registration's real default (email-only - see
  // the sms_enabled seed migration) for any later test relying on it,
  // not just both-on.
  const restoreBody = await fullChannelsBody(admin.csrfToken, { text_event_registration: false, email_event_registration: true });
  await request(app).post('/main-admin/notifications/channels').set('Cookie', admin.cookie).type('form').send(restoreBody);
});

// A real request: "a notifications settings card to control email,
// text and push notifications." No real push-delivery mechanism exists
// yet (utils/notifications.js's own notify() only ever attempts email/
// sms) - the user explicitly asked for the preference toggle to be
// added now anyway, ready for whenever a real push channel is wired up.
test('GET /notifications/preferences shows a Push column, and a saved push preference persists and shows pre-filled', async () => {
  const parent = await createParentAccount();

  const page = await request(app).get('/notifications/preferences').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<tr><th>Type<\/th><th>Email<\/th><th>Text<\/th><th>Push<\/th><\/tr>/);

  const types = await notifications.listTypes();
  const payload = { _csrf: parent.csrfToken };
  for (const type of types) {
    payload[`email_${type.key}`] = '1';
    payload[`sms_${type.key}`] = '1';
    payload[`push_${type.key}`] = type.key === 'newsletter_sent' ? '0' : '1';
  }
  await request(app).post('/notifications/preferences').set('Cookie', parent.cookie).type('form').send(payload);

  const prefs = await notifications.preferencesForAccount(parent.accountId);
  const newsletterPref = prefs.find((p) => p.type.key === 'newsletter_sent');
  assert.equal(newsletterPref.push, 0);
  const otherPref = prefs.find((p) => p.type.key === 'forum_reply');
  assert.equal(otherPref.push, 1);

  const reloaded = await request(app).get('/notifications/preferences').set('Cookie', parent.cookie);
  const newsletterRow = /<td>Newsletter Sent<[\s\S]*?<\/tr>/.exec(reloaded.text)[0];
  assert.doesNotMatch(newsletterRow, /name="push_newsletter_sent" value="1" checked/);
  // forum_reply's own stable type_key is untouched by the Forums-to-
  // Chat rename - only its own label column changed to "Chat Reply".
  const chatReplyRow = /<td>Chat Reply<[\s\S]*?<\/tr>/.exec(reloaded.text)[0];
  assert.match(chatReplyRow, /name="push_forum_reply" value="1" checked/);
});

test('sending a newsletter issue notifies every active member account', async () => {
  const parent = await createParentAccount();

  // A real request moved newsletter admin to a single always-current
  // issue (GET /main-admin/newsletter auto-creates one, no more POST /
  // creation route) - seeded directly here the same way a real draft
  // would exist by the time it goes out. A later real request ("the
  // newsletter being sent out is controlled by the newsletter schedule
  // settings already built on the page") removed the manual Mark Sent
  // HTTP route entirely - markSent() itself is unchanged, just no longer
  // reachable directly over HTTP, so this calls it the same way
  // advanceIfDue/the "Send newsletter immediately" checkbox do now.
  const mainAdminAccount = await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(process.env.MAIN_ADMIN_EMAIL);
  const issueId = await newsletterUtil.createDraft('Notify Everyone', mainAdminAccount.id);
  await newsletterUtil.markSent(issueId);

  const items = await notifications.listForAccount(parent.accountId);
  assert.ok(items.some((i) => i.type_key === 'newsletter_sent' && i.link_url === `/newsletter/${issueId}`));
});

test('GET /main-admin/notifications renders a Text and an Email checkbox per type, checked per their own column', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/notifications').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<th>Text<\/th><th>Email<\/th>/);
  assert.match(page.text, /name="email_event_registration" value="1" checked/);
  // event_registration is one of the email-only types from an earlier
  // real request - its text checkbox should render unchecked.
  assert.match(page.text, /name="text_event_registration" value="1"\s*\/>/);
  const typeCheckedState = await notifications.getType('event_registration');
  assert.equal(typeCheckedState.sms_enabled, 0, 'event_registration should be seeded email-only (text unchecked)');
});

test('POST /main-admin/notifications/channels flips only the submitted type, leaving every other type untouched', async () => {
  const admin = await loginAsMainAdmin();
  const before = await notifications.getType('floater_assignment');
  assert.equal(before.sms_enabled, 1);
  assert.equal(before.email_enabled, 1);

  const body = await fullChannelsBody(admin.csrfToken, { text_floater_assignment: false });
  await request(app).post('/main-admin/notifications/channels').set('Cookie', admin.cookie).type('form').send(body);

  const afterFloater = await notifications.getType('floater_assignment');
  assert.equal(afterFloater.sms_enabled, 0, 'floater_assignment text should now be off');
  assert.equal(afterFloater.email_enabled, 1, 'floater_assignment email should be unaffected');

  const otherType = await notifications.getType('class_registration');
  assert.equal(otherType.sms_enabled, 0, 'class_registration was already email-only before this POST and should stay that way');
  assert.equal(otherType.email_enabled, 1);

  // Restore for any later test relying on default channel behavior.
  const restoreBody = await fullChannelsBody(admin.csrfToken, { text_floater_assignment: true });
  await request(app).post('/main-admin/notifications/channels').set('Cookie', admin.cookie).type('form').send(restoreBody);
});

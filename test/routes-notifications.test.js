// Route-level coverage for the SMS/notification framework (Community &
// Commerce track, item 11). See utils/notifications.js's own comments:
// notify() always creates the in-app notification (the Notification
// Center's own data), and only attempts email/sms when the type's
// auto_send_enabled is on and the recipient hasn't opted out - there's
// no real SMS/email provider configured anywhere, so those channels
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

test("turning a type's auto-send off stops email/sms but keeps the in-app notification", async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();

  await request(app).post('/main-admin/notifications/event_registration/auto-send').set('Cookie', admin.cookie).type('form').send({ enabled: '0', _csrf: admin.csrfToken });

  const eventId = await createPublishedEvent(admin);
  await request(app).post(`/events/${eventId}/register`).set('Cookie', parent.cookie).type('form').send({ memberId: parent.memberId, _csrf: parent.csrfToken });

  const items = await notifications.listForAccount(parent.accountId);
  assert.equal(items.length, 1);
  const deliveries = await db.prepare('SELECT * FROM notification_deliveries WHERE notification_id = ?').all(items[0].id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].channel, 'in_app');

  // Restore for any later test relying on default auto-send behavior.
  await request(app).post('/main-admin/notifications/event_registration/auto-send').set('Cookie', admin.cookie).type('form').send({ enabled: '1', _csrf: admin.csrfToken });
});

test('sending a newsletter issue notifies every active member account', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();

  const createRes = await request(app).post('/main-admin/newsletter').set('Cookie', admin.cookie).type('form').send({ subject: 'Notify Everyone', _csrf: admin.csrfToken });
  const issueId = /\/main-admin\/newsletter\/(\d+)\/edit/.exec(createRes.headers.location)[1];
  await request(app).post(`/main-admin/newsletter/${issueId}/send`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const items = await notifications.listForAccount(parent.accountId);
  assert.ok(items.some((i) => i.type_key === 'newsletter_sent' && i.link_url === `/newsletter/${issueId}`));
});

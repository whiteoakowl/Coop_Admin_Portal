// Coverage for Communication > Text tab (item 13) - a real request: "text
// tab should have the same structure as email but simpler, a text box
// with a 50 word cap." Shares utils/emailComposer.js's own
// listRecipientCandidates() for filtering (already covered in depth by
// test/routes-communication-email.test.js) - this file checks the
// text-specific wiring: the simpler compose screen, the 50-word cap
// being enforced server-side (not just in the browser), and send-now vs.
// schedule-then-manually-send on both portals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `communication-text-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `communication-text-test-uploads-${process.pid}`);
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

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/announcements/text').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function seedStudentAccount(suffix) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Text Family ${suffix}') RETURNING id`).get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'student', ?, 1) RETURNING id")
      .get(`Text Student ${suffix}`, `text-student-${suffix}`, familyId)
  ).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, 'x', 'active', now_text()) RETURNING id")
      .get(memberId, `text-student-${suffix}@example.com`)
  ).id;
  const roleId = (await db.prepare("SELECT id FROM roles WHERE key = 'student'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, roleId);
  return accountId;
}

test('Main Admin Text tab: same candidate list/filter/select-all wiring as Email, reached at /main-admin/announcements/text', async () => {
  const { cookie } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainA');

  const page = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="view-tab active" href="\/main-admin\/announcements\/text">Text</);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox`));
  assert.match(page.text, />Filter</);
  assert.match(page.text, /id="email-select-all"/);
  assert.match(page.text, />Create Text</);
});

test('Main Admin Text: compose screen has a plain textarea (no rich-text toolbar, no subject/reply-to), and Send Now creates a sent text campaign', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainB');

  const composeRes = await request(app)
    .post('/main-admin/announcements/text/compose')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)] });
  assert.equal(composeRes.status, 200);
  assert.match(composeRes.text, /<textarea name="body"/);
  assert.doesNotMatch(composeRes.text, /data-forum-editor/);
  assert.doesNotMatch(composeRes.text, /name="replyTo"/);
  assert.doesNotMatch(composeRes.text, /name="subject"/);

  const sendRes = await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Wednesday session is cancelled today.', sendOption: 'now' });
  assert.equal(sendRes.status, 302);
  assert.match(sendRes.headers.location, /notice=/);

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Wednesday session is cancelled today.'").get();
  assert.ok(campaign);
  assert.equal(campaign.status, 'sent');
  assert.equal(campaign.recipient_count, 1);

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND member_account_id = ?").get(accountId);
  assert.ok(notif, 'expected the recipient to get an in-app notification for the text');
});

test('Main Admin Text: a message over 50 words is rejected server-side, not just capped in the browser', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainC');
  const longBody = Array.from({ length: 51 }, (_, i) => `word${i}`).join(' ');

  const res = await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: longBody, sendOption: 'now' });
  assert.equal(res.status, 200);
  assert.match(res.text, /capped at 50 words/);

  const campaign = await db.prepare('SELECT * FROM text_campaigns WHERE body = ?').get(longBody);
  assert.equal(campaign, undefined, 'an over-limit text must not be saved/sent');
});

test('Main Admin Text: scheduling saves a scheduled text without notifying yet, and Send Now on it dispatches and flips it to sent', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainD');
  const scheduledAt = '2027-01-01T09:00';

  const sendRes = await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'See you Monday.', sendOption: 'schedule', scheduledAt });
  assert.equal(sendRes.status, 302);

  let campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'See you Monday.'").get();
  assert.equal(campaign.status, 'scheduled');

  let notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND member_account_id = ? AND body = 'See you Monday.'").get(accountId);
  assert.equal(notif, undefined, 'a scheduled text must not notify anyone until it is actually sent');

  const manualSendRes = await request(app)
    .post(`/main-admin/announcements/text/${campaign.id}/send`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken });
  assert.equal(manualSendRes.status, 302);

  campaign = await db.prepare('SELECT * FROM text_campaigns WHERE id = ?').get(campaign.id);
  assert.equal(campaign.status, 'sent');

  notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND member_account_id = ? AND body = 'See you Monday.'").get(accountId);
  assert.ok(notif);
});

test('Co-op Admin Text tab: same wiring, reached at /admin/announcements/text', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const accountId = await seedStudentAccount('coopA');

  const page = await request(app).get('/admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox`));

  const sendRes = await request(app)
    .post('/admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Coop reminder text.', sendOption: 'now' });
  assert.equal(sendRes.status, 302);

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Coop reminder text.'").get();
  assert.ok(campaign);
  assert.equal(campaign.sent_by_portal, 'coop_admin');
});

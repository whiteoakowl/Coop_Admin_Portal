// Coverage for the combined Communication > Text/Email page - a real
// request: "There is a sub page for text and a subpage for email.
// Combine them and call it Text/Email. This page will have three
// buttons at the top. Filter, send text, send email. When you click on
// each of these buttons it goes to a new page where you can complete
// the tasks and write the message." This file checks the part that's
// genuinely new: Filter's selection carries over (via req.session) to
// Send Text/Send Email, and Send Text/Send Email reach every active
// member when nothing has been filtered yet, on both portals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `communication-text-email-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `communication-text-email-filter-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/announcements/text-email').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/announcements/text-email').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let seedCounter = 0;
async function seedStudentAccount(suffix) {
  seedCounter += 1;
  const n = seedCounter;
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Filter Family ${suffix}-${n}') RETURNING id`).get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'student', ?, 1) RETURNING id")
      .get(`Filter Student ${suffix}-${n}`, `filter-student-${suffix}-${n}`, familyId)
  ).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, 'x', 'active', now_text()) RETURNING id")
      .get(memberId, `filter-student-${suffix}-${n}@example.com`)
  ).id;
  const roleId = (await db.prepare("SELECT id FROM roles WHERE key = 'student'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, roleId);
  return accountId;
}

test('Main Admin: with no filter saved, Send Text and Send Email both default to every active candidate', async () => {
  const { cookie } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('noFilterMain');

  const sendText = await request(app).get('/main-admin/announcements/text-email/send-text').set('Cookie', cookie);
  assert.equal(sendText.status, 200);
  assert.match(sendText.text, new RegExp(`name="recipientIds" value="${accountId}"`));

  const sendEmail = await request(app).get('/main-admin/announcements/text-email/send-email').set('Cookie', cookie);
  assert.equal(sendEmail.status, 200);
  assert.match(sendEmail.text, new RegExp(`name="recipientIds" value="${accountId}"`));
});

test('Main Admin: saving a Filter selection carries over to both Send Text and Send Email, and the landing page shows the count', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const chosenId = await seedStudentAccount('chosenMain');
  const otherId = await seedStudentAccount('otherMain');

  const filterRes = await request(app)
    .post('/main-admin/announcements/text-email/filter')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(chosenId)] });
  assert.equal(filterRes.status, 302);
  assert.match(filterRes.headers.location, /\/main-admin\/announcements\/text-email\?notice=/);

  const landing = await request(app).get('/main-admin/announcements/text-email').set('Cookie', cookie);
  assert.match(landing.text, /Filtered to 1 recipient/);

  const sendText = await request(app).get('/main-admin/announcements/text-email/send-text').set('Cookie', cookie);
  assert.match(sendText.text, new RegExp(`name="recipientIds" value="${chosenId}"`));
  assert.doesNotMatch(sendText.text, new RegExp(`name="recipientIds" value="${otherId}"`));

  const sendEmail = await request(app).get('/main-admin/announcements/text-email/send-email').set('Cookie', cookie);
  assert.match(sendEmail.text, new RegExp(`name="recipientIds" value="${chosenId}"`));
  assert.doesNotMatch(sendEmail.text, new RegExp(`name="recipientIds" value="${otherId}"`));

  // Clearing the filter (an empty submission) resets to "every active
  // member" for both Send Text/Send Email - not a 0-recipient dead end.
  const clearRes = await request(app)
    .post('/main-admin/announcements/text-email/filter')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken });
  assert.equal(clearRes.status, 302);
  assert.match(decodeURIComponent(clearRes.headers.location), /Filter cleared/);

  const sendTextAfterClear = await request(app).get('/main-admin/announcements/text-email/send-text').set('Cookie', cookie);
  assert.match(sendTextAfterClear.text, new RegExp(`name="recipientIds" value="${otherId}"`));
});

test('Co-op Admin: Filter selection on /admin/announcements/text-email/filter carries over to Send Text/Send Email the same way', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const chosenId = await seedStudentAccount('chosenCoop');
  const otherId = await seedStudentAccount('otherCoop');

  await request(app)
    .post('/admin/announcements/text-email/filter')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(chosenId)] });

  const sendText = await request(app).get('/admin/announcements/text-email/send-text').set('Cookie', cookie);
  assert.equal(sendText.status, 200);
  assert.match(sendText.text, new RegExp(`name="recipientIds" value="${chosenId}"`));
  assert.doesNotMatch(sendText.text, new RegExp(`name="recipientIds" value="${otherId}"`));
});

// Coverage for the Approval/Denial letters' rich-text editor - a real
// request: "approval and denial messages should have the same text
// editing icons we added to other chat boxes." routes/main-admin-
// members.js's POST /settings/letters/:kind now sanitizes the body as
// HTML (utils/sanitizeHtml.js's sanitizePostBody) instead of just
// trimming plain text, and utils/membershipApprovals.js's sendLetter
// converts any still-plain-text legacy body to HTML paragraphs so a
// letter saved before this change still displays with its paragraph
// breaks intact in the recipient's Notification Center.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `membership-letters-richtext-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `membership-letters-richtext-test-uploads-${process.pid}`);
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
const membershipApprovals = require('../utils/membershipApprovals');

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
  const page = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('POST /main-admin/members/settings/letters/approval sanitizes rich-text HTML into the stored template', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/settings/letters/approval')
    .set('Cookie', cookie)
    .type('form')
    .send({ subject: 'Welcome!', body: '<p>Hi {{name}}, <strong>welcome</strong>!</p><script>alert(1)</script>', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const templates = await membershipApprovals.getLetterTemplates();
  assert.match(templates.approval.body, /<strong>welcome<\/strong>/);
  assert.doesNotMatch(templates.approval.body, /<script>/);

  const settingsPage = await request(app).get('/main-admin/members?tab=settings').set('Cookie', cookie);
  assert.match(settingsPage.text, /<strong>welcome<\/strong>/);
});

test('a legacy plain-text letter body still shows its paragraph breaks in the recipient Notification Center', async () => {
  await db.prepare("UPDATE membership_letter_templates SET body = ? WHERE kind = 'approval'").run('Hi {{name}},\n\nWelcome aboard!\n\nSee you soon.');

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('RichTextLetterFamily') RETURNING id").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Letter Recipient', 'letter-recipient', 'parent', ?) RETURNING id").get(familyId)).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'letter-recipient@example.com', ?, 'pending') RETURNING id")
      .get(memberId, hashPassword('testpassword123'))
  ).id;

  await membershipApprovals.approveRequest(accountId, null);

  const loginRes = await request(app).post('/login').type('form').send({ email: 'letter-recipient@example.com', password: 'testpassword123', next: '/notifications' });
  const cookie = loginRes.headers['set-cookie'];
  const notificationsPage = await request(app).get('/notifications').set('Cookie', cookie);
  assert.match(notificationsPage.text, /<p>Hi Letter Recipient,<\/p>/);
  assert.match(notificationsPage.text, /<p>Welcome aboard!<\/p>/);
});

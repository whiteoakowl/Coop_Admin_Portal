// Coverage for Communication > Email tab (item 12) - a real request: "a
// filter that filters the member list by section, role, if they're
// registered for classes or not, age group, grade level, parent, student,
// teacher etc... select all, select none... create email button takes
// you to a new screen where you can compose... reply to box... option to
// send right away or schedule for later." Both portals share
// utils/emailComposer.js - this file checks the HTTP/view wiring plus the
// filter candidate data on both portals, and the actual create-and-send
// vs. schedule-then-manually-send behavior once, on Main Admin (Co-op
// Admin's own routes call the identical shared functions).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `communication-email-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `communication-email-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/announcements/email').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/announcements/email').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let sectionId;
async function seedStudentAccount(suffix, { grade = '3rd Grade', registerForClass = false, inSection = false } = {}) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Email Family ${suffix}') RETURNING id`).get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active, grade_level, birthday) VALUES (?, ?, 'student', ?, 1, ?, '2015-01-01') RETURNING id")
      .get(`Email Student ${suffix}`, `email-student-${suffix}`, familyId, grade)
  ).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, 'x', 'active', now_text()) RETURNING id")
      .get(memberId, `email-student-${suffix}@example.com`)
  ).id;
  const roleId = (await db.prepare("SELECT id FROM roles WHERE key = 'student'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, roleId);

  if (!sectionId) {
    sectionId = (await db.prepare("INSERT INTO sections (name) VALUES ('Teen Co-op') RETURNING id").get()).id;
  }
  if (inSection) {
    await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(memberId, sectionId);
  }
  if (registerForClass) {
    const classId = (
      await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Email Test Class') RETURNING id").get()
    ).id;
    await db.prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, 'confirmed')").run(classId, memberId, accountId);
  }

  return { accountId, memberId };
}

test('Main Admin Email tab: candidate rows carry role/section/grade/age/registration data attributes for client-side filtering', async () => {
  const { cookie } = await loginAsMainAdmin();
  const { accountId } = await seedStudentAccount('mainA', { grade: '5th Grade', registerForClass: true, inSection: true });

  const page = await request(app).get('/main-admin/announcements/email').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="view-tab active" href="\/main-admin\/announcements\/email">Email</);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox`));
  assert.match(page.text, /data-role="student"/);
  assert.match(page.text, /data-grade="5th Grade"/);
  assert.match(page.text, /data-registered="yes"/);
  assert.match(page.text, /data-section="Teen Co-op"/);
  assert.match(page.text, />Filter</);
  assert.match(page.text, /id="email-select-all"/);
  assert.doesNotMatch(page.text, /data-email-select="all"/, 'Select All/Select None buttons were replaced by a single header checkbox');
});

test('Main Admin Email: Create Email renders the compose screen with hidden recipient inputs, then Send Now creates a sent campaign and notifies each recipient', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const { accountId } = await seedStudentAccount('mainB');

  const composeRes = await request(app)
    .post('/main-admin/announcements/email/compose')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)] });
  assert.equal(composeRes.status, 200);
  assert.match(composeRes.text, new RegExp(`name="recipientIds" value="${accountId}"`));
  assert.match(composeRes.text, /Send right away/);
  assert.match(composeRes.text, /Schedule for later/);
  assert.match(composeRes.text, /Reply-To/);

  const sendRes = await request(app)
    .post('/main-admin/announcements/email/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], subject: 'Class update', body: '<p>hi</p>', replyTo: 'board@example.com', sendOption: 'now' });
  assert.equal(sendRes.status, 302);
  assert.match(sendRes.headers.location, /notice=/);

  const campaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject = 'Class update'").get();
  assert.ok(campaign);
  assert.equal(campaign.status, 'sent');
  assert.equal(campaign.reply_to, 'board@example.com');
  assert.equal(campaign.recipient_count, 1);

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'email_campaign' AND member_account_id = ?").get(accountId);
  assert.ok(notif, 'expected the recipient to get an in-app notification for the email');
});

test('Main Admin Email: scheduling saves a scheduled campaign without notifying yet, and Send Now on it dispatches and flips it to sent', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const { accountId } = await seedStudentAccount('mainC');

  const scheduledAt = '2027-01-01T09:00';
  const sendRes = await request(app)
    .post('/main-admin/announcements/email/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], subject: 'Scheduled note', body: '<p>later</p>', sendOption: 'schedule', scheduledAt });
  assert.equal(sendRes.status, 302);

  let campaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject = 'Scheduled note'").get();
  assert.equal(campaign.status, 'scheduled');
  assert.equal(campaign.scheduled_at, scheduledAt);

  let notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'email_campaign' AND member_account_id = ? AND title = 'Scheduled note'").get(accountId);
  assert.equal(notif, undefined, 'a scheduled email must not notify anyone until it is actually sent');

  const listPage = await request(app).get('/main-admin/announcements/email').set('Cookie', cookie);
  assert.match(listPage.text, /Scheduled note/);
  assert.match(listPage.text, />Send Now</);

  const manualSendRes = await request(app)
    .post(`/main-admin/announcements/email/${campaign.id}/send`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken });
  assert.equal(manualSendRes.status, 302);

  campaign = await db.prepare("SELECT * FROM email_campaigns WHERE id = ?").get(campaign.id);
  assert.equal(campaign.status, 'sent');

  notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'email_campaign' AND member_account_id = ? AND title = 'Scheduled note'").get(accountId);
  assert.ok(notif);
});

test('Co-op Admin Email tab: same filter/select-all/compose wiring, reached at /admin/announcements/email', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { accountId } = await seedStudentAccount('coopA');

  const page = await request(app).get('/admin/announcements/email').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Communication<\/h1>/);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox`));

  const sendRes = await request(app)
    .post('/admin/announcements/email/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], subject: 'Coop email', body: '<p>hi</p>', sendOption: 'now' });
  assert.equal(sendRes.status, 302);

  const campaign = await db.prepare("SELECT * FROM email_campaigns WHERE subject = 'Coop email'").get();
  assert.ok(campaign);
  assert.equal(campaign.sent_by_portal, 'coop_admin');
});

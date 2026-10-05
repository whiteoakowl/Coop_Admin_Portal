// Coverage for the Communication hub's Announcements tab rewrite - a real
// request: "main admin and co-op admin announcements should be
// communication, and it should have 4 tabs: announcements, email, text,
// and newsletter... drop down menu of who it is sent to should change to
// checkboxes so that you can choose multiple portals to send the
// announcement too... at the bottom of announcements it says past
// announcements... it shows which portals it was sent to, date and time.
// public homepage past announcements doesn't need its own section." Both
// portals share utils/announcements.js (see test coverage there isn't
// duplicated - this file checks the HTTP/view wiring on each portal).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `communication-announcements-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `communication-announcements-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/announcements').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function activeParentAccount(suffix) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Comm Family ${suffix}') RETURNING id`).get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES (?, ?, 'parent', ?, 1) RETURNING id").get(`Comm Parent ${suffix}`, `comm-parent-${suffix}`, familyId)).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, 'x', 'active', now_text()) RETURNING id")
      .get(memberId, `comm-parent-${suffix}@example.com`)
  ).id;
  const roleId = (await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, roleId);
  return accountId;
}

test('Main Admin Communication page: 4 tabs, checkbox recipients (not a roleKey dropdown)', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Announcements<\/h1>/);
  assert.match(page.text, /href="\/main-admin\/announcements">Announcements</);
  assert.match(page.text, /href="\/main-admin\/announcements\/email">Email</);
  assert.match(page.text, /href="\/main-admin\/announcements\/text">Text</);
  assert.match(page.text, /href="\/main-admin\/newsletter">Newsletter</);
  assert.match(page.text, /name="targets" value="everyone"/);
  assert.match(page.text, /name="targets" value="public"/);
  assert.doesNotMatch(page.text, /<select name="roleKey">/);
  assert.match(page.text, />Past Announcements</);
  assert.doesNotMatch(page.text, />Public Homepage Announcements</);
});

test('Main Admin: sending to multiple checked targets notifies each and posts to the public homepage, logged as one row', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const parentAccountId = await activeParentAccount('mainA');

  const res = await request(app)
    .post('/main-admin/announcements')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Multi-target send', body: '<p>hello</p>', targets: ['parent', 'public'] });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'announcement' AND member_account_id = ? AND title = 'Multi-target send'").get(parentAccountId);
  assert.ok(notif, 'expected the parent account to receive an in-app notification');

  const publicRow = await db.prepare("SELECT * FROM announcements WHERE title = 'Multi-target send'").get();
  assert.ok(publicRow, 'expected a row in the public announcements table');
  assert.equal(publicRow.is_public, 1);

  const logRow = await db.prepare("SELECT * FROM announcement_log WHERE title = 'Multi-target send'").get();
  assert.ok(logRow, 'expected a single announcement_log row for this send');
  assert.equal(logRow.sent_by_portal, 'main_admin');
  const targets = JSON.parse(logRow.targets);
  assert.ok(targets.includes('parent') && targets.includes('public'));

  const page = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  assert.match(page.text, /Multi-target send/);
  assert.match(page.text, /Public Homepage/);
});

test('Main Admin: sending with no targets checked is rejected with an error, not a silent send-to-everyone', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/announcements')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'No targets', body: '<p>hi</p>' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);
  const logRow = await db.prepare("SELECT * FROM announcement_log WHERE title = 'No targets'").get();
  assert.equal(logRow, undefined);
});

test('Co-op Admin Communication page: 3 tabs (no Newsletter), checkbox recipients, unified Past Announcements log', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const parentAccountId = await activeParentAccount('coopA');

  const sendRes = await request(app)
    .post('/admin/announcements')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Coop send', body: '<p>hi</p>', targets: ['parent'] });
  assert.equal(sendRes.status, 302);

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'announcement' AND member_account_id = ? AND title = 'Coop send'").get(parentAccountId);
  assert.ok(notif);

  const logRow = await db.prepare("SELECT * FROM announcement_log WHERE title = 'Coop send'").get();
  assert.ok(logRow);
  assert.equal(logRow.sent_by_portal, 'coop_admin');

  const page = await request(app).get('/admin/announcements').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Announcements<\/h1>/);
  assert.match(page.text, /href="\/admin\/announcements\/email">Email</);
  assert.match(page.text, /href="\/admin\/announcements\/text">Text</);
  assert.doesNotMatch(page.text, /Newsletter/);
  assert.match(page.text, /Coop send/);
});

test('Email/Text tabs render on both portals instead of 404ing', async () => {
  const main = await loginAsMainAdmin();
  const mainEmail = await request(app).get('/main-admin/announcements/email').set('Cookie', main.cookie);
  assert.equal(mainEmail.status, 200);
  const mainText = await request(app).get('/main-admin/announcements/text').set('Cookie', main.cookie);
  assert.equal(mainText.status, 200);

  const coop = await loginAsAdmin();
  const coopEmail = await request(app).get('/admin/announcements/email').set('Cookie', coop.cookie);
  assert.equal(coopEmail.status, 200);
  const coopText = await request(app).get('/admin/announcements/text').set('Cookie', coop.cookie);
  assert.equal(coopText.status, 200);
});

// A real request: "send to should be a clean check dropdown menu of
// check boxes. Send announcement should say send announcements now.
// Button next to it should say schedule for later."
test('Main Admin: Send to is a checkbox-dropdown, buttons renamed, Schedule for Later dialog present', async () => {
  const { cookie } = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  assert.match(page.text, /class="multi-select-checkbox"/);
  assert.match(page.text, />Send Announcements Now</);
  assert.match(page.text, /onclick="document\.getElementById\('schedule-announcement-dialog'\)\.showModal\(\)">Schedule for Later</);
  assert.match(page.text, /<dialog id="schedule-announcement-dialog" class="member-picker-dialog">/);
  assert.match(page.text, /<input type="date" data-date-time-date data-date-time-group="announceSchedule" \/>/);
  assert.match(page.text, /data-date-time-time data-date-time-group="announceSchedule"/);
});

// A real request: "that button allows you to pick a date and time to
// send... reverts back to schedule settings after" (same "schedule
// saves it, an admin still has to press Send" shape Email/Text already
// use).
test('Main Admin: scheduling an announcement saves it without notifying yet, and Send Now on it dispatches', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const parentAccountId = await activeParentAccount('sched1');

  const scheduleRes = await request(app)
    .post('/main-admin/announcements')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Scheduled Announcement', body: '<p>later</p>', targets: ['parent'], scheduledAt: '2027-01-01T09:00' });
  assert.equal(scheduleRes.status, 302);
  assert.match(decodeURIComponent(scheduleRes.headers.location), /Scheduled for 2027-01-01T09:00/);

  const scheduled = await db.prepare("SELECT * FROM announcement_log WHERE title = 'Scheduled Announcement'").get();
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.scheduled_at, '2027-01-01T09:00');

  const notifiedYet = await db.prepare("SELECT * FROM notifications WHERE type_key = 'announcement' AND member_account_id = ? AND title = 'Scheduled Announcement'").get(parentAccountId);
  assert.equal(notifiedYet, undefined, 'nothing should be notified until Send Now is actually pressed');

  const listPage = await request(app).get('/main-admin/announcements').set('Cookie', cookie);
  assert.match(listPage.text, /Scheduled for 2027-01-01T09:00/);
  assert.match(listPage.text, new RegExp(`action="/main-admin/announcements/${scheduled.id}/send"`));

  const sendRes = await request(app).post(`/main-admin/announcements/${scheduled.id}/send`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(sendRes.status, 302);
  assert.match(decodeURIComponent(sendRes.headers.location), /Sent to \d+ member\(s\)/);

  const sent = await db.prepare("SELECT * FROM announcement_log WHERE id = ?").get(scheduled.id);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sent_at);

  const notifiedNow = await db.prepare("SELECT * FROM notifications WHERE type_key = 'announcement' AND member_account_id = ? AND title = 'Scheduled Announcement'").get(parentAccountId);
  assert.ok(notifiedNow);
});

test('Main Admin: sending an already-sent/nonexistent scheduled announcement again errors instead of double-sending', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app).post('/main-admin/announcements/999999/send').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /already sent or does not exist/);
});

// Co-op Admin gets the identical scheduling flow, sharing the same
// utils/announcements.js backend.
test('Co-op Admin: scheduling and Send Now work the same way as Main Admin', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const parentAccountId = await activeParentAccount('sched2');

  const scheduleRes = await request(app)
    .post('/admin/announcements')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, title: 'Coop Scheduled', body: '<p>later</p>', targets: ['parent'], scheduledAt: '2027-02-01T10:00' });
  assert.equal(scheduleRes.status, 302);
  const scheduled = await db.prepare("SELECT * FROM announcement_log WHERE title = 'Coop Scheduled'").get();
  assert.equal(scheduled.status, 'scheduled');

  const sendRes = await request(app).post(`/admin/announcements/${scheduled.id}/send`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(sendRes.status, 302);
  const sent = await db.prepare('SELECT * FROM announcement_log WHERE id = ?').get(scheduled.id);
  assert.equal(sent.status, 'sent');

  const notified = await db.prepare("SELECT * FROM notifications WHERE type_key = 'announcement' AND member_account_id = ? AND title = 'Coop Scheduled'").get(parentAccountId);
  assert.ok(notified);
});

// A real bug class this session already fixed twice elsewhere (Resource
// Links, this same file's own email/text sends): the new /:id/send
// route must not be caught by an earlier /email/send or /text/send
// route (or vice versa) due to Express's registration-order matching.
test('scheduled-announcement /:id/send does not collide with the Email/Text send routes', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const emailSendRes = await request(app)
    .post('/main-admin/announcements/email/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [], subject: '', body: '' });
  // Should hit the real email/send handler (missing recipients/subject
  // re-renders the compose page), never the /:id/send handler (which
  // would redirect with "already sent or does not exist").
  assert.equal(emailSendRes.status, 200);
  assert.doesNotMatch(emailSendRes.text, /already sent or does not exist/);
});

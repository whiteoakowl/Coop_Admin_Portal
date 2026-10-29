// Coverage for Communication > Text tab (item 13) - a real request: "text
// tab should have the same structure as email but simpler, a text box
// with a 50 word cap." Shares utils/emailComposer.js's own
// listRecipientCandidates() for filtering (already covered in depth by
// test/routes-communication-email.test.js) - this file checks the
// text-specific wiring: the simpler compose screen, the 50-word cap
// being enforced server-side (not just in the browser), photo/MMS
// attachment, and send-now vs. schedule-then-manually-send on both
// portals.
//
// A later real request: "separate text and email subpages again...
// Page should show a list of all members. Then filter button narrows
// it down in a popup screen." Text and Email are two separate pages
// again (no more combined /text-email + session-backed /text-email/
// filter page) - the full candidate list and the Filter <dialog> both
// live directly on GET /text now.
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
const scheduledCampaigns = require('../utils/scheduledCampaigns');

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

async function seedStudentAccount(suffix, { phone = null } = {}) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Text Family ${suffix}') RETURNING id`).get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active, phone) VALUES (?, ?, 'student', ?, 1, ?) RETURNING id")
      .get(`Text Student ${suffix}`, `text-student-${suffix}`, familyId, phone)
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

test('Main Admin Text page: renders directly (no more redirect to a combined Text/Email page), with a Filter button/dialog and the full member list shown, every row checked by default', async () => {
  const { cookie } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainRenders');

  const page = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Text<\/h1>/);
  assert.match(page.text, /showModal\(\)">Filter</);
  assert.match(page.text, /<dialog id="text-filter-dialog"/);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox checked`));
  assert.match(page.text, /id="email-select-all" aria-label="Select all" checked/);
});

test('Main Admin Text page: the candidate table shows only Name/Email/Phone columns, with Select All in the header cell, and shrinks instead of stacking on mobile', async () => {
  const { cookie } = await loginAsMainAdmin();
  await seedStudentAccount('mainPhone', { phone: '555-456-7890' });

  const page = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<table class="roster-table condensed-table" id="email-candidate-table">/);
  assert.doesNotMatch(page.text, /id="email-candidate-table"[^>]*table-stack-mobile|table-stack-mobile[^>]*id="email-candidate-table"/);
  assert.match(page.text, /<tr><th class="no-print"><input type="checkbox" id="email-select-all" aria-label="Select all" checked \/><\/th><th>Name<\/th><th>Email<\/th><th>Phone<\/th><\/tr>/);
  assert.match(page.text, />555-456-7890</);
});

test('Main Admin Text: compose screen has a plain textarea (no rich-text toolbar, no subject/reply-to) plus an optional image field, and Send Now creates a sent text campaign', async () => {
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
  // A real request: "Click send text button... It should have an option
  // to upload a photo."
  assert.match(composeRes.text, /<input type="file" name="image" accept="image\/\*" \/>/);
  assert.match(composeRes.text, /enctype="multipart\/form-data"/);

  const sendRes = await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Wednesday session is cancelled today.', sendOption: 'now' });
  assert.equal(sendRes.status, 302);
  assert.match(sendRes.headers.location, /\/main-admin\/announcements\/text\?notice=/);

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Wednesday session is cancelled today.'").get();
  assert.ok(campaign);
  assert.equal(campaign.status, 'sent');
  assert.equal(campaign.recipient_count, 1);
  assert.equal(campaign.media_url, null, 'no image was attached, so media_url should stay null');

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND member_account_id = ?").get(accountId);
  assert.ok(notif, 'expected the recipient to get an in-app notification for the text');
});

test('Main Admin Text: attaching an image uploads it and stores the resulting media_url on the campaign', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainImage');

  const sendRes = await request(app)
    .post('/main-admin/announcements/text/send')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .field('recipientIds', String(accountId))
    .field('body', 'See the attached flyer.')
    .field('sendOption', 'now')
    .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { filename: 'flyer.png', contentType: 'image/png' });
  assert.equal(sendRes.status, 302);

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'See the attached flyer.'").get();
  assert.ok(campaign);
  assert.ok(campaign.media_url, 'expected an uploaded image to produce a stored media_url');
});

// A real request: "Set 160 character length for all texting features
// across the app."
test('Main Admin Text: a message over 160 characters is rejected server-side, not just capped in the browser', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainC');
  const longBody = 'a'.repeat(161);

  const res = await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: longBody, sendOption: 'now' });
  assert.equal(res.status, 200);
  assert.match(res.text, /capped at 160 characters/);

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

// A real request: "Scheduling text to be sent later. Repair this
// feature so that when it is scheduled it will automatically send
// according to that schedule instead of having to come back and click
// send manually." utils/scheduledCampaigns.js's own dispatchDueTextCampaigns()
// runs opportunistically on every request (server.js) - exercised here
// directly rather than via a real request, so the test doesn't depend
// on the in-process debounce timing.
test('scheduledAt is stored in the same now_text()-comparable format sent_at already uses', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainFormat');

  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Format check.', sendOption: 'schedule', scheduledAt: '2027-06-01T09:30' });

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Format check.'").get();
  assert.match(campaign.scheduled_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'should be stored as a plain UTC "YYYY-MM-DD HH:MM:SS" string, not the raw datetime-local input');
});

// A real request: "Fix date and time format to match the rest of the
// site. This should be hard coded somewhere so it's always coded this
// way... List of sent texts and email pages should be a single row.
// Status next to title the column for number of recipients and column
// for date and time." Checks the Past & Scheduled Texts list this
// renders into (partials/communication-campaign-list.ejs), fed by
// utils/dates.js's own shared formatFriendlyTimestamp().
test('Past & Scheduled Texts: one row per campaign, status shown next to the message, recipients and a combined formatted Date & Time column, no raw timestamp text', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const sentId = await seedStudentAccount('mainListSent');
  const scheduledId = await seedStudentAccount('mainListScheduled');

  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(sentId)], body: 'Row layout sent check.', sendOption: 'now' });
  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(scheduledId)], body: 'Row layout scheduled check.', sendOption: 'schedule', scheduledAt: '2027-03-15T14:30' });

  const page = await request(app).get('/main-admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<th>Message<\/th><th>Recipients<\/th><th>Date &amp; Time<\/th><th><\/th>/, 'Status is no longer its own column');

  const sentRowMatch = new RegExp('<td class="roster-name-col">\\s*Row layout sent check\\.\\s*<span class="badge-pill badge-pill-green">Sent</span>\\s*</td>').exec(page.text);
  assert.ok(sentRowMatch, 'expected the Sent status badge directly next to the message text, in the same cell');

  const scheduledRowMatch = new RegExp('<td class="roster-name-col">\\s*Row layout scheduled check\\.\\s*<span class="badge-pill badge-pill-orange">Scheduled</span>\\s*</td>').exec(page.text);
  assert.ok(scheduledRowMatch, 'expected the Scheduled status badge directly next to the message text, in the same cell');

  // Not the raw "YYYY-MM-DD HH:MM:SS" string - the shared friendly
  // formatter's own "Month D, YYYY H:MMam/pm" shape.
  assert.doesNotMatch(page.text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(page.text, /March 15, 2027/, 'the scheduled date should read through the shared friendly formatter');
  assert.match(page.text, /Scheduled for /, 'a still-scheduled row shows "Scheduled for ..." in its Date & Time column');
});

test('a text scheduled for a time already past gets automatically sent, with no admin action', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainAuto');

  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Auto-send me.', sendOption: 'schedule', scheduledAt: '2020-01-01T09:00' });

  let campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Auto-send me.'").get();
  assert.equal(campaign.status, 'scheduled');

  scheduledCampaigns.resetDebounceForTest();
  await scheduledCampaigns.dispatchDueTextCampaigns();

  campaign = await db.prepare('SELECT * FROM text_campaigns WHERE id = ?').get(campaign.id);
  assert.equal(campaign.status, 'sent', 'a past-due scheduled text should be sent without anyone clicking Send');

  const notif = await db.prepare("SELECT * FROM notifications WHERE type_key = 'text_message' AND member_account_id = ? AND body = 'Auto-send me.'").get(accountId);
  assert.ok(notif);
});

test('a text scheduled for the future is left alone by the automatic dispatcher', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainFuture');

  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Not yet.', sendOption: 'schedule', scheduledAt: '2099-01-01T09:00' });

  scheduledCampaigns.resetDebounceForTest();
  await scheduledCampaigns.dispatchDueTextCampaigns();

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Not yet.'").get();
  assert.equal(campaign.status, 'scheduled', 'a future-scheduled text must not be sent early');
});

test('the dispatcher debounces - calling it again immediately does not re-check for due campaigns', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const accountId = await seedStudentAccount('mainDebounce');

  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Debounce check.', sendOption: 'schedule', scheduledAt: '2020-01-01T09:00' });

  // First call (debounce reset) actually checks and sends it.
  scheduledCampaigns.resetDebounceForTest();
  await scheduledCampaigns.dispatchDueTextCampaigns();
  let campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Debounce check.'").get();
  assert.equal(campaign.status, 'sent');

  // A second scheduled text created right after, without resetting the
  // debounce, should NOT be auto-sent by an immediate second call - the
  // debounce is still within its window.
  await request(app)
    .post('/main-admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Debounced away.', sendOption: 'schedule', scheduledAt: '2020-01-01T09:00' });
  await scheduledCampaigns.dispatchDueTextCampaigns();
  campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Debounced away.'").get();
  assert.equal(campaign.status, 'scheduled', 'still within the debounce window, so this call should have been a no-op');
});

test('Co-op Admin Text page: same full-list/filter-dialog/compose wiring, reached directly at /admin/announcements/text', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const accountId = await seedStudentAccount('coopA', { phone: '555-222-3344' });

  const page = await request(app).get('/admin/announcements/text').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`value="${accountId}" data-email-checkbox checked`));
  assert.match(page.text, /<tr><th class="no-print"><input type="checkbox" id="email-select-all" aria-label="Select all" checked \/><\/th><th>Name<\/th><th>Email<\/th><th>Phone<\/th><\/tr>/);
  assert.match(page.text, />555-222-3344</);

  const sendRes = await request(app)
    .post('/admin/announcements/text/send')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, recipientIds: [String(accountId)], body: 'Coop reminder text.', sendOption: 'now' });
  assert.equal(sendRes.status, 302);
  assert.match(sendRes.headers.location, /\/admin\/announcements\/text\?notice=/);

  const campaign = await db.prepare("SELECT * FROM text_campaigns WHERE body = 'Coop reminder text.'").get();
  assert.ok(campaign);
  assert.equal(campaign.sent_by_portal, 'coop_admin');
});

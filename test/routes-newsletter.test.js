// Route-level coverage for the Weekly Newsletter (Community & Commerce
// track, item 10). See utils/newsletter.js's own comments: content is
// assembled from real, live tables, "sending" is a status change with a
// real recipient_count snapshot (never a real email dispatch), and only
// status='sent' issues ever appear in the member-facing archive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `newsletter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `newsletter-test-uploads-${process.pid}`);
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

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/newsletter' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/newsletter').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createDraft(admin, subject) {
  const res = await request(app).post('/main-admin/newsletter').set('Cookie', admin.cookie).type('form').send({ subject, _csrf: admin.csrfToken });
  return /\/main-admin\/newsletter\/(\d+)\/edit/.exec(res.headers.location)[1];
}

test('newsletter admin requires sign-in', async () => {
  const res = await request(app).get('/main-admin/newsletter');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('member newsletter archive requires sign-in', async () => {
  const res = await request(app).get('/newsletter');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('creating a draft assembles real content from live announcements', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("INSERT INTO announcements (title, body, published_at) VALUES (?, ?, now_text())").run('Picture Day', 'Picture day is next Friday.');

  const id = await createDraft(admin, 'Weekly Update');
  const editPage = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, /Picture Day/);
  assert.match(editPage.text, /Picture day is next Friday\./);

  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.status, 'draft');
  assert.match(issue.body_html, /Picture Day/);
});

test('editing a draft persists sanitized HTML', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Sanitize Me');

  await request(app)
    .post(`/main-admin/newsletter/${id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ subject: 'Edited Subject', bodyHtml: '<p>Hello</p><script>alert(1)</script>', _csrf: admin.csrfToken });

  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.subject, 'Edited Subject');
  assert.match(issue.body_html, /<p>Hello<\/p>/);
  assert.doesNotMatch(issue.body_html, /<script>/);
});

test('scheduling and unscheduling toggles status without losing the draft', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Schedule Me');

  await request(app).post(`/main-admin/newsletter/${id}/schedule`).set('Cookie', admin.cookie).type('form').send({ scheduledAt: '2026-09-01T09:00', _csrf: admin.csrfToken });
  let issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.status, 'scheduled');
  assert.equal(issue.scheduled_at, '2026-09-01T09:00');

  await request(app).post(`/main-admin/newsletter/${id}/unschedule`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.status, 'draft');
  assert.equal(issue.scheduled_at, null);
});

test('marking sent records a real recipient snapshot and flips status', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Send Me');

  await request(app).post(`/main-admin/newsletter/${id}/send`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.status, 'sent');
  assert.ok(issue.sent_at);
  const activeCount = Number((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE status = 'active'").get()).c);
  assert.equal(issue.recipient_count, activeCount);
});

test('only sent issues appear in the member-facing archive; drafts and scheduled ones stay hidden', async () => {
  const admin = await loginAsMainAdmin();
  const parent = await createParentAccount();

  const draftId = await createDraft(admin, 'Still A Draft');
  const scheduledId = await createDraft(admin, 'Still Scheduled');
  await request(app).post(`/main-admin/newsletter/${scheduledId}/schedule`).set('Cookie', admin.cookie).type('form').send({ scheduledAt: '2026-09-01T09:00', _csrf: admin.csrfToken });
  const sentId = await createDraft(admin, 'Already Sent');
  await request(app).post(`/main-admin/newsletter/${sentId}/send`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const listPage = await request(app).get('/newsletter').set('Cookie', parent.cookie);
  assert.match(listPage.text, /Already Sent/);
  assert.doesNotMatch(listPage.text, /Still A Draft/);
  assert.doesNotMatch(listPage.text, /Still Scheduled/);

  const draftDetail = await request(app).get(`/newsletter/${draftId}`).set('Cookie', parent.cookie);
  assert.equal(draftDetail.status, 404);
  const scheduledDetail = await request(app).get(`/newsletter/${scheduledId}`).set('Cookie', parent.cookie);
  assert.equal(scheduledDetail.status, 404);
  const sentDetail = await request(app).get(`/newsletter/${sentId}`).set('Cookie', parent.cookie);
  assert.equal(sentDetail.status, 200);
  assert.match(sentDetail.text, /Already Sent/);
});

test('the old "Re-assemble from Live Data" route is gone - not needed since events auto-update at creation time', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'No Regenerate Here');
  const res = await request(app).post(`/main-admin/newsletter/${id}/regenerate`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 404);

  const editPage = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  assert.doesNotMatch(editPage.text, /Re-assemble from Live Data/);
});

// A real request: "don't show this week's classes. show the next 4 weeks
// of events from the event calendar." An event 5 weeks out is real, live
// data, but well outside the newsletter's own lookahead window.
test('assembled content shows events within the next 4 weeks, omits classes entirely, and always includes Quick Links', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Should Not Appear Class')").run();
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Soon Event', to_char(now() + interval '10 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Far Off Event', to_char(now() + interval '40 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();

  const id = await createDraft(admin, 'Four Week Window');
  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.match(issue.body_html, /Soon Event/);
  assert.doesNotMatch(issue.body_html, /Far Off Event/, 'an event over 4 weeks out should not appear');
  assert.doesNotMatch(issue.body_html, /Should Not Appear Class/);
  assert.doesNotMatch(issue.body_html, /This Week's Classes/i);
  assert.match(issue.body_html, /Quick Links/);
  assert.match(issue.body_html, /href="\/absence"/);
  assert.match(issue.body_html, /href="\/name-tag"/);
});

// A real request: "add a button for view newsletter."
test('View Newsletter previews a draft/scheduled issue through the real member-facing template', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Preview Me');

  const editPage = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, new RegExp(`href="/main-admin/newsletter/${id}/preview"`));
  assert.match(editPage.text, />View Newsletter</);

  const previewRes = await request(app).get(`/main-admin/newsletter/${id}/preview`).set('Cookie', admin.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /Preview Me/);
  assert.match(previewRes.text, /not sent yet/);
});

// A real request: "if you click schedule, a pop up window should show to
// pick the date and time."
test('Schedule is a dialog, not an inline datetime input directly in the Actions row', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Schedule Dialog');
  const editPage = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, /<dialog id="newsletter-schedule-dialog"/);
  assert.match(editPage.text, /onclick="document\.getElementById\('newsletter-schedule-dialog'\)\.showModal\(\)">Schedule</);
});

// A real request: "buttons at the bottom. save, schedule, mark sent and
// delete should all be on the same row, mobile."
test('Save/Schedule/Mark Sent/Delete/View Newsletter all sit in one toolbar row', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'One Row');
  const editPage = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  const rowMatch = /<div class="roster-btn-row roster-btn-row-nowrap">([\s\S]*?)<\/div>/.exec(editPage.text);
  assert.ok(rowMatch, 'expected the actions toolbar row');
  const row = rowMatch[1];
  assert.match(row, /form="newsletter-edit-form" class="roster-action-btn">Save</);
  assert.match(row, />Schedule</);
  assert.match(row, />Mark Sent</);
  assert.match(row, />Delete</);
  assert.match(row, />View Newsletter</);
});

test('deleting a draft removes it', async () => {
  const admin = await loginAsMainAdmin();
  const id = await createDraft(admin, 'Delete Me');

  await request(app).post(`/main-admin/newsletter/${id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });

  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue, undefined);
});

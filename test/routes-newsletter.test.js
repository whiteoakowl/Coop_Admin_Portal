// Route-level coverage for the Weekly Newsletter (Community & Commerce
// track, item 10). See utils/newsletter.js's own comments: content is
// assembled from real, live tables, "sending" is a status change with a
// real recipient_count snapshot (never a real email dispatch), and only
// status='sent' issues ever appear in the member-facing archive.
//
// A real request: "there should only be one newsletter to edit. remove
// the table and add new issue buttons and features. when you click on
// the newsletter subpage it should have all the editing features and
// newsletter textbox on that page." GET /main-admin/newsletter now always
// resolves to exactly one current draft/scheduled issue (auto-created the
// moment none exists - routes/admin-newsletter.js's own currentIssue()),
// rather than listing every issue for an admin to pick from. The member-
// facing archive (routes/newsletter.js) is unaffected - it still browses
// every past 'sent' issue - so several tests below seed multiple issues
// directly through utils/newsletter.js rather than through the (now
// single-issue) admin HTTP flow, the same way they'd really accumulate
// over several weeks of real use.
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
  return { cookie, csrfToken: extractCsrf(page.text), accountId: (await db.prepare('SELECT id FROM member_accounts WHERE email = ?').get(process.env.MAIN_ADMIN_EMAIL)).id };
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

// Clears every non-sent issue first so each test starts from a known,
// single, freshly auto-created draft - GET / always leaves exactly one
// behind (currentIssue()'s own auto-create), same as real admin use.
async function freshCurrentIssue(admin) {
  await db.prepare("DELETE FROM newsletter_issues WHERE status IN ('draft', 'scheduled')").run();
  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  const id = (await db.prepare("SELECT id FROM newsletter_issues WHERE status IN ('draft', 'scheduled') ORDER BY created_at DESC, id DESC LIMIT 1").get()).id;
  return { id, page };
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

// A real request (see file header): only one newsletter to edit, ever.
test('GET /main-admin/newsletter always has exactly one current issue to edit, auto-created when none exists', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("DELETE FROM newsletter_issues").run();

  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  const issues = await db.prepare('SELECT * FROM newsletter_issues').all();
  assert.equal(issues.length, 1, 'exactly one issue should have been auto-created');
  assert.equal(issues[0].status, 'draft');
  assert.match(page.text, new RegExp(`name="subject" value="${issues[0].subject}"`));

  // No list/table, no "+ New Issue" creation flow left anywhere on the page.
  assert.doesNotMatch(page.text, /\+ New Issue/);
  assert.doesNotMatch(page.text, /<table/);

  // Loading again doesn't create a second one.
  await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM newsletter_issues').get()).c, 1);
});

test('the old per-issue edit URL redirects to the single newsletter page', async () => {
  const admin = await loginAsMainAdmin();
  const { id } = await freshCurrentIssue(admin);
  const res = await request(app).get(`/main-admin/newsletter/${id}/edit`).set('Cookie', admin.cookie);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/main-admin/newsletter');
});

test('marking the current issue sent leaves a brand new draft to edit next', async () => {
  const admin = await loginAsMainAdmin();
  const { id: sentId } = await freshCurrentIssue(admin);

  await request(app).post(`/main-admin/newsletter/${sentId}/send`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  const sent = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(sentId);
  assert.equal(sent.status, 'sent');

  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  const current = await db.prepare("SELECT * FROM newsletter_issues WHERE status IN ('draft', 'scheduled') ORDER BY created_at DESC, id DESC LIMIT 1").get();
  assert.ok(current, 'a fresh draft should exist after the previous one was sent');
  assert.notEqual(current.id, sentId);
  assert.match(page.text, new RegExp(`action="/main-admin/newsletter/${current.id}"`));
});

test('deleting the current draft leaves a brand new one to edit next', async () => {
  const admin = await loginAsMainAdmin();
  const { id } = await freshCurrentIssue(admin);

  await request(app).post(`/main-admin/newsletter/${id}/delete`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(await db.prepare('SELECT 1 FROM newsletter_issues WHERE id = ?').get(id), undefined);

  await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  const current = await db.prepare("SELECT * FROM newsletter_issues WHERE status IN ('draft', 'scheduled') ORDER BY created_at DESC, id DESC LIMIT 1").get();
  assert.ok(current, 'a fresh draft should exist after the old one was deleted');
  assert.notEqual(current.id, id);
});

// The automatic content (body_html) is assembled once at creation and no
// longer rendered as its own editable box on the edit page (a real
// request collapsed that to one textbox - see the "only one for writing
// the main message" test below) - visible on View Newsletter instead.
test('the current draft assembles real content from live announcements', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("DELETE FROM newsletter_issues").run();
  await db.prepare("INSERT INTO announcements (title, body, published_at) VALUES (?, ?, now_text())").run('Picture Day', 'Picture day is next Friday.');

  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);

  const issue = await db.prepare("SELECT * FROM newsletter_issues WHERE status = 'draft'").get();
  assert.match(issue.body_html, /Picture Day/);
  assert.match(issue.body_html, /Picture day is next Friday\./);

  const preview = await request(app).get(`/main-admin/newsletter/${issue.id}/preview`).set('Cookie', admin.cookie);
  assert.match(preview.text, /Picture Day/);
});

// A real request: "why are there two editing feature boxes on
// newsletter there should only be one for writing the main message" -
// the edit page's single textbox is custom_note now (renamed Newsletter
// Message); body_html stays exactly as assembleContent() produced it at
// createDraft time and is no longer writable through this route.
test('editing the current draft persists sanitized HTML to its one message textbox, leaving the auto-assembled content alone', async () => {
  const admin = await loginAsMainAdmin();
  const { id } = await freshCurrentIssue(admin);
  const original = await db.prepare('SELECT body_html FROM newsletter_issues WHERE id = ?').get(id);

  await request(app)
    .post(`/main-admin/newsletter/${id}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ subject: 'Edited Subject', customNote: '<p>Hello</p><script>alert(1)</script>', _csrf: admin.csrfToken });

  const issue = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(id);
  assert.equal(issue.subject, 'Edited Subject');
  assert.match(issue.custom_note, /<p>Hello<\/p>/);
  assert.doesNotMatch(issue.custom_note, /<script>/);
  assert.equal(issue.body_html, original.body_html, 'the automatic content should be untouched by this save');
});

test('scheduling and unscheduling toggles status without losing the draft', async () => {
  const admin = await loginAsMainAdmin();
  const { id } = await freshCurrentIssue(admin);

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
  const { id } = await freshCurrentIssue(admin);

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
  await db.prepare("DELETE FROM newsletter_issues").run();

  const draftId = await newsletterUtil.createDraft('Still A Draft', admin.accountId);
  const scheduledId = await newsletterUtil.createDraft('Still Scheduled', admin.accountId);
  await newsletterUtil.scheduleIssue(scheduledId, '2026-09-01T09:00');
  const sentId = await newsletterUtil.createDraft('Already Sent', admin.accountId);
  await newsletterUtil.markSent(sentId);

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
  const { id, page } = await freshCurrentIssue(admin);
  const res = await request(app).post(`/main-admin/newsletter/${id}/regenerate`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(res.status, 404);
  assert.doesNotMatch(page.text, /Re-assemble from Live Data/);
});

// A real request: "don't show this week's classes. show the next 4 weeks
// of events from the event calendar." An event 5 weeks out is real, live
// data, but well outside the newsletter's own lookahead window.
test('assembled content shows events within the next 4 weeks, omits a general class schedule, and always includes the Get Involved/Co-op links', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("DELETE FROM newsletter_issues").run();
  await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Should Not Appear Class')").run();
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Soon Event', to_char(now() + interval '10 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();
  await db
    .prepare("INSERT INTO events (title, starts_at, status) VALUES ('Far Off Event', to_char(now() + interval '40 days', 'YYYY-MM-DD HH24:MI:SS'), 'published')")
    .run();

  await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  const issue = await db.prepare("SELECT * FROM newsletter_issues WHERE status = 'draft'").get();
  assert.match(issue.body_html, /Soon Event/);
  assert.doesNotMatch(issue.body_html, /Far Off Event/, 'an event over 4 weeks out should not appear');
  assert.doesNotMatch(issue.body_html, /Should Not Appear Class/);
  assert.doesNotMatch(issue.body_html, /This Week's Classes/i);
  // A real request: "a button for business directory view and view
  // classifieds. Button for join a committee. Co-op section with a
  // button for the absence/late form and a button for the name tag
  // form" - standing links, always present regardless of live data.
  assert.match(issue.body_html, /Get Involved/);
  assert.match(issue.body_html, /href="\/directory"/);
  assert.match(issue.body_html, /href="\/classifieds"/);
  assert.match(issue.body_html, /href="\/committees"/);
  assert.match(issue.body_html, /Co-op/);
  assert.match(issue.body_html, /href="\/absence"/);
  assert.match(issue.body_html, /href="\/name-tag"/);
});

// A real request: "it should show a list of classes still needing a
// teacher or assistant" - the exact same live classesWithOpenStaffSlots
// query the Co-op Classes page's own button already uses.
test('assembled content lists a class still missing a teacher, omits one that is fully staffed', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("DELETE FROM newsletter_issues").run();
  // Monday is always seeded as an active class_schedules day from a
  // fresh database (supabase/migrations/20261025010000's own header
  // comment), with semester_id null - no need to create one.
  const unstaffed = (await db.prepare("INSERT INTO classes (day, hour_position, class_name, teacher_slots) VALUES ('monday', 1, 'Understaffed Class', 1) RETURNING id").get()).id;
  const staffedId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name, teacher_slots) VALUES ('monday', 2, 'Fully Staffed Class', 1) RETURNING id").get()).id;
  const teacherId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Staffing Teacher', 'staffing-teacher', 'parent', 1) RETURNING id").get()).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(staffedId, teacherId);
  void unstaffed;

  await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  const issue = await db.prepare("SELECT * FROM newsletter_issues WHERE status = 'draft'").get();
  assert.match(issue.body_html, /Classes Needing a Teacher or Assistant/);
  assert.match(issue.body_html, /Understaffed Class/);
  assert.doesNotMatch(issue.body_html, /Fully Staffed Class/);
});

// A real request: "add a button for view newsletter."
test('View Newsletter previews the current draft/scheduled issue through the real member-facing template', async () => {
  const admin = await loginAsMainAdmin();
  const { id, page } = await freshCurrentIssue(admin);

  assert.match(page.text, new RegExp(`href="/main-admin/newsletter/${id}/preview"`));
  assert.match(page.text, />View Newsletter</);

  const previewRes = await request(app).get(`/main-admin/newsletter/${id}/preview`).set('Cookie', admin.cookie);
  assert.equal(previewRes.status, 200);
  assert.match(previewRes.text, /not sent yet/);
});

// A real request: "remove schedule button at the bottom. we only
// schedule through the edit schedule button at the top" - the per-issue
// one-time Schedule button/dialog is gone; only the top Edit Weekly
// Schedule dialog is left.
test('the bottom Actions row has no per-issue Schedule button or dialog any more', async () => {
  const admin = await loginAsMainAdmin();
  const { page } = await freshCurrentIssue(admin);
  assert.doesNotMatch(page.text, /id="newsletter-schedule-dialog"/);
  assert.doesNotMatch(page.text, />Schedule</);
});

// A real request: "buttons at the bottom. save, schedule, mark sent and
// delete should all be on the same row, mobile" - schedule dropped out
// of this row by a later request (see test above); Save/Mark Sent/
// Delete/View Newsletter stay together.
test('Save/Mark Sent/Delete/View Newsletter all sit in one toolbar row', async () => {
  const admin = await loginAsMainAdmin();
  const { page } = await freshCurrentIssue(admin);
  const rowMatch = /<div class="roster-btn-row roster-btn-row-nowrap">([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(rowMatch, 'expected the actions toolbar row');
  const row = rowMatch[1];
  assert.match(row, /form="newsletter-edit-form" class="roster-action-btn">Save</);
  assert.match(row, />Mark Sent</);
  assert.match(row, />Delete</);
  assert.match(row, />View Newsletter</);
});

// A real request: "weekly schedule should also be an orange buttons and
// say edit weekly schedule and be a popup."
test('Edit Weekly Schedule is a popup dialog, not a <details> disclosure', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Weekly Send Schedule<\/summary>/, 'the old <details> disclosure should be gone');
  assert.match(page.text, /<dialog id="edit-schedule-dialog" class="member-picker-dialog">/);
  assert.match(page.text, /onclick="document\.getElementById\('edit-schedule-dialog'\)\.showModal\(\)">Edit Weekly Schedule</);
  assert.match(page.text, /<h3>Edit Weekly Schedule<\/h3>/);
});

// A real request: "check box under send automatically every week for
// send newsletter immediately for a quick one time send out off
// schedule. Reverts back to schedule settings after."
test('Send newsletter immediately sends the most recent unsent issue, and the schedule settings save independently either way', async () => {
  const admin = await loginAsMainAdmin();
  await db.prepare("DELETE FROM newsletter_issues WHERE status IN ('draft', 'scheduled')").run();
  const olderId = await newsletterUtil.createDraft('Older Draft', admin.accountId);
  const newerId = await newsletterUtil.createDraft('Newer Draft', admin.accountId);

  const res = await request(app)
    .post('/main-admin/newsletter/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'Friday', time: '09:30', enabled: '1', sendNow: '1', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /sent immediately/);

  const newer = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(newerId);
  const older = await db.prepare('SELECT * FROM newsletter_issues WHERE id = ?').get(olderId);
  assert.equal(newer.status, 'sent', 'the most recently created unsent issue should be the one sent immediately');
  assert.equal(older.status, 'draft', 'an older draft should be left alone');

  const page = await request(app).get('/main-admin/newsletter').set('Cookie', admin.cookie);
  assert.match(page.text, /value="Friday" selected/);
  assert.match(page.text, /value="09:30"/);
  assert.match(page.text, /name="enabled" value="1" checked/);
  // sendNow is a one-time action, never persisted - always unchecked again.
  assert.doesNotMatch(page.text, /name="sendNow" value="1" checked/);
});

test('Send newsletter immediately with nothing eligible still saves the schedule and says so', async () => {
  const admin = await loginAsMainAdmin();
  // Clear out every draft/scheduled issue (including any left over from
  // earlier tests in this file) so there's genuinely nothing eligible.
  await db.prepare("DELETE FROM newsletter_issues WHERE status IN ('draft', 'scheduled')").run();

  const res = await request(app)
    .post('/main-admin/newsletter/settings')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ day: 'Monday', time: '08:00', sendNow: '1', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Nothing to send immediately/);
});

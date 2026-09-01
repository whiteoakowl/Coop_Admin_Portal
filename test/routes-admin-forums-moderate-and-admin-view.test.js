// Coverage for three related Chat changes, all from the same real
// request thread:
//
// 1. "I added one chat category and it will not allow me to add more." ->
//    views/admin-forums-list.ejs's Add Category dialog nested a per-
//    category delete <form> inside the outer Add Category <form>, which
//    is invalid HTML and left Save attached to nothing once a category
//    existed. Fixed by moving Save outside the form (associated via its
//    form="..." attribute) so nothing nests.
//
// 2. "Moderate tab should have a list of the chat categories. when you
//    click each category it show a pop up of the category's name,
//    description, check box - allow comments, checkboxes - select which
//    section can view or all, dropdown menu to select member to
//    moderate." -> POST /main-admin/forums/:id/settings
//    (utils/forums.js's updateCategorySettings), enforced by
//    routes/forums.js (allow_comments gates replies; forum_category_
//    sections extends canAccessCategory; a category's own
//    moderator_member_id lets that one member moderate without
//    manage_forum).
//
// 3. "when you click on the chat category it should open an admin view
//    of the threads in that category... it should stay in the main admin
//    portal[.] admin chat category view shows a list of each thread to
//    click on to read with an archive button at the end. admin can click
//    on each thread to read the post and comments. trash and edit button
//    next to each post and comment for admin to edit." -> new admin-
//    scoped routes/views under /main-admin/forums (routes/admin-
//    forums.js's own "Admin thread/post browsing" section).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-forums-moderate-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-forums-moderate-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
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
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Moderate Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Moderate Parent ${familyCounter}`, code, code, familyId);
  const email = `moderate-parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/forums' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/forums').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyId };
}

test('the Add Category dialog has no nested <form> - Save is associated via form="..." instead', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/forums').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<form method="POST" action="\/main-admin\/forums" id="add-forum-category-form">/);
  assert.match(res.text, /<button type="submit" form="add-forum-category-form" class="primary-btn">Save<\/button>/);
});

test('Moderate tab lists categories with an Edit button, no old moderation-log table', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Moderate Tab Test Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Moderate Tab Test Chat'").get();

  const res = await request(app).get('/main-admin/forums?tab=moderate').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Moderate Tab Test Chat/);
  assert.match(res.text, new RegExp(`id="moderate-category-${category.id}"`));
  assert.match(res.text, /action="\/main-admin\/forums\/\d+\/settings"/);
  assert.doesNotMatch(res.text, /<th>Moderator<\/th>/);
});

test('updating a category\'s settings sets allow_comments, sections, and a moderator', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Settings Test Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Settings Test Chat'").get();

  const sectionInfo = await db.prepare("INSERT INTO sections (name) VALUES ('Teen Co-op')").run();
  const moderator = await createParentAccount();

  const res = await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({
      name: 'Settings Test Chat',
      description: 'Updated description',
      sectionIds: String(sectionInfo.lastInsertRowid),
      moderatorMemberId: String(moderator.memberId),
      _csrf: admin.csrfToken,
      // allowComments deliberately omitted - an unchecked checkbox.
    });
  assert.equal(res.status, 302);

  const updated = await db.prepare('SELECT * FROM forum_categories WHERE id = ?').get(category.id);
  assert.equal(updated.description, 'Updated description');
  assert.equal(updated.allow_comments, 0);
  assert.equal(updated.moderator_member_id, moderator.memberId);
  const sectionRow = await db.prepare('SELECT * FROM forum_category_sections WHERE category_id = ?').get(category.id);
  assert.ok(sectionRow, 'expected a forum_category_sections row for the selected section');
});

test('allow_comments off blocks a reply from a non-moderator but not from the assigned moderator', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'No Comments Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'No Comments Chat'").get();

  const moderator = await createParentAccount();
  await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'No Comments Chat', moderatorMemberId: String(moderator.memberId), _csrf: admin.csrfToken });

  const author = await createParentAccount();
  const threadRes = await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Announcement', body: '<p>Read only</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(threadRes.headers.location)[1];

  const blocked = await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ body: '<p>Trying to comment</p>', _csrf: author.csrfToken });
  assert.match(decodeURIComponent(blocked.headers.location), /Comments are turned off/);

  const allowed = await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', moderator.cookie)
    .type('form')
    .send({ body: '<p>Moderator reply</p>', _csrf: moderator.csrfToken });
  assert.equal(allowed.status, 302);
  assert.doesNotMatch(decodeURIComponent(allowed.headers.location || ''), /Comments are turned off/);
});

test('a member without the assigned section cannot access a section-restricted category, one with it can', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Section Restricted Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Section Restricted Chat'").get();
  const sectionInfo = await db.prepare("INSERT INTO sections (name) VALUES ('Restricted Section')").run();
  await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Section Restricted Chat', sectionIds: String(sectionInfo.lastInsertRowid), allowComments: 'on', _csrf: admin.csrfToken });

  const outsider = await createParentAccount();
  const outsiderView = await request(app).get(`/forums/${category.id}`).set('Cookie', outsider.cookie);
  assert.equal(outsiderView.status, 403);

  const inSection = await createParentAccount();
  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(inSection.memberId, sectionInfo.lastInsertRowid);
  const memberView = await request(app).get(`/forums/${category.id}`).set('Cookie', inSection.cookie);
  assert.equal(memberView.status, 200);
});

test('the assigned category moderator can remove a post without holding manage_forum', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Moderator Assignment Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Moderator Assignment Chat'").get();

  const author = await createParentAccount();
  const threadRes = await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Needs moderation', body: '<p>Some content</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(threadRes.headers.location)[1];
  const post = await db.prepare('SELECT id FROM forum_posts WHERE thread_id = ?').get(threadId);

  const assignedModerator = await createParentAccount();
  const notModerator = await createParentAccount();
  await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Moderator Assignment Chat', moderatorMemberId: String(assignedModerator.memberId), allowComments: 'on', _csrf: admin.csrfToken });

  const denied = await request(app).post(`/forums/threads/${threadId}/posts/${post.id}/remove`).set('Cookie', notModerator.cookie).type('form').send({ _csrf: notModerator.csrfToken });
  assert.equal(denied.status, 403);

  const removed = await request(app).post(`/forums/threads/${threadId}/posts/${post.id}/remove`).set('Cookie', assignedModerator.cookie).type('form').send({ _csrf: assignedModerator.csrfToken });
  assert.equal(removed.status, 302);

  const view = await request(app).get(`/forums/threads/${threadId}`).set('Cookie', author.cookie);
  assert.match(view.text, /removed by a moderator/);
});

test('clicking a chat category from Main Admin opens the admin thread view, not the member-facing /forums route', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Admin View Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Admin View Chat'").get();

  const newTab = await request(app).get('/main-admin/forums?tab=new').set('Cookie', admin.cookie);
  assert.match(newTab.text, new RegExp(`href="/main-admin/forums/${category.id}"`));
  assert.doesNotMatch(newTab.text, new RegExp(`href="/forums/${category.id}"`));

  const author = await createParentAccount();
  const threadRes = await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Admin View Thread', body: '<p>Original post</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(threadRes.headers.location)[1];
  await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ body: '<p>A comment</p>', _csrf: author.csrfToken });

  const categoryView = await request(app).get(`/main-admin/forums/${category.id}`).set('Cookie', admin.cookie);
  assert.equal(categoryView.status, 200);
  assert.match(categoryView.text, /portal-nav-title">Main Admin</);
  assert.match(categoryView.text, /Admin View Thread/);
  assert.match(categoryView.text, new RegExp(`action="/main-admin/forums/threads/${threadId}/archive"`));

  const threadView = await request(app).get(`/main-admin/forums/threads/${threadId}`).set('Cookie', admin.cookie);
  assert.equal(threadView.status, 200);
  assert.match(threadView.text, /portal-nav-title">Main Admin</);
  assert.match(threadView.text, /Original post/);
  assert.match(threadView.text, /A comment/);
  assert.match(threadView.text, /class="hint">Post &middot;/);
  assert.match(threadView.text, /class="hint">Comment &middot;/);
  const post = await db.prepare('SELECT id FROM forum_posts WHERE thread_id = ? ORDER BY created_at LIMIT 1').get(threadId);
  assert.match(threadView.text, new RegExp(`action="/main-admin/forums/threads/${threadId}/posts/${post.id}/edit"`));
  assert.match(threadView.text, new RegExp(`action="/main-admin/forums/threads/${threadId}/posts/${post.id}/remove"`));
});

test('admin Trash and Edit actually remove/edit a post from the admin thread view', async () => {
  const admin = await loginAsMainAdmin();
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Admin Edit Trash Chat', scope: 'general', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Admin Edit Trash Chat'").get();

  const author = await createParentAccount();
  const threadRes = await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Trash Edit Thread', body: '<p>Original body</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(threadRes.headers.location)[1];
  const post = await db.prepare('SELECT id FROM forum_posts WHERE thread_id = ?').get(threadId);

  const editRes = await request(app)
    .post(`/main-admin/forums/threads/${threadId}/posts/${post.id}/edit`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ body: '<p>Edited by admin</p>', _csrf: admin.csrfToken });
  assert.equal(editRes.status, 302);
  let stored = await db.prepare('SELECT body_html, edited_at FROM forum_posts WHERE id = ?').get(post.id);
  assert.match(stored.body_html, /Edited by admin/);
  assert.ok(stored.edited_at);

  const trashRes = await request(app)
    .post(`/main-admin/forums/threads/${threadId}/posts/${post.id}/remove`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(trashRes.status, 302);
  stored = await db.prepare('SELECT status FROM forum_posts WHERE id = ?').get(post.id);
  assert.equal(stored.status, 'removed');

  const archiveRes = await request(app)
    .post(`/main-admin/forums/threads/${threadId}/archive`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ _csrf: admin.csrfToken });
  assert.equal(archiveRes.status, 302);
  assert.match(archiveRes.headers.location, new RegExp(`/main-admin/forums/${category.id}$`));
  const thread = await db.prepare('SELECT status FROM forum_threads WHERE id = ?').get(threadId);
  assert.equal(thread.status, 'archived');
});

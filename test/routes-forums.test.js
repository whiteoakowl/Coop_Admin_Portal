// Route-level coverage for Forums (Community & Commerce track, item 6).
// See utils/forums.js's own comments and supabase/migrations/
// 20260825060000_forums.sql for the design this exercises: general vs.
// private class-scoped categories, moderation gated by the
// manage_forum permission (grantable to any role, not just main_admin),
// and server-side HTML sanitization of post bodies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `forums-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `forums-test-uploads-${process.pid}`);
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

// A dedicated, throwaway role holding manage_forum - granted to
// individual accounts ALONGSIDE their own 'parent' role, never onto the
// shared 'parent' role itself. The 5 system roles from db/bootstrapPg.js
// are shared by every account created in this file, so mutating one
// directly (e.g. granting manage_forum to 'parent') would leak forum-
// moderation rights onto every other parent account this file creates,
// including ones other tests rely on staying an ordinary, non-moderator
// member. Created once and memoized.
let moderatorRoleId = null;
async function getModeratorRoleId() {
  if (moderatorRoleId) return moderatorRoleId;
  const roleInfo = await db.prepare("INSERT INTO roles (key, label, description, is_system) VALUES ('test_forum_moderator', 'Test Forum Moderator', 'Test-only role granting manage_forum.', 0)").run();
  moderatorRoleId = roleInfo.lastInsertRowid;
  const perm = await db.prepare("SELECT id FROM permissions WHERE key = 'manage_forum'").get();
  await db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(moderatorRoleId, perm.id);
  return moderatorRoleId;
}

let familyCounter = 0;
async function createParentAccount({ grantForumModeration = false } = {}) {
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

  if (grantForumModeration) {
    const roleId = await getModeratorRoleId();
    await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, roleId);
  }

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/forums' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/forums').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid, familyId };
}

async function createGeneralCategory(admin) {
  const res = await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'General Chat', scope: 'general', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  const row = await db.prepare("SELECT id FROM forum_categories WHERE name = 'General Chat'").get();
  return row.id;
}

test('forums require sign-in - no public browsing', async () => {
  const res = await request(app).get('/forums');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login\?next=/);
});

test('a signed-in member can start a thread in a general category and another member can reply', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createGeneralCategory(admin);

  const author = await createParentAccount();
  const createRes = await request(app)
    .post(`/forums/${categoryId}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Hello everyone', body: '<p>First post</p>', _csrf: author.csrfToken });
  const threadMatch = /\/forums\/threads\/(\d+)/.exec(createRes.headers.location);
  assert.ok(threadMatch, 'expected a redirect to the new thread');
  const threadId = threadMatch[1];

  const replier = await createParentAccount();
  const replyRes = await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', replier.cookie)
    .type('form')
    .send({ body: '<p>Welcome!</p>', _csrf: replier.csrfToken });
  assert.equal(replyRes.status, 302);

  const view = await request(app).get(`/forums/threads/${threadId}`).set('Cookie', author.cookie);
  assert.match(view.text, /First post/);
  assert.match(view.text, /Welcome!/);
});

test('post bodies are sanitized server-side - a script tag never reaches the page', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createGeneralCategory(admin);
  const author = await createParentAccount();

  const createRes = await request(app)
    .post(`/forums/${categoryId}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'XSS attempt', body: '<p>Hi<script>alert(1)</script></p><img src=x onerror=alert(2)>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(createRes.headers.location)[1];

  const stored = await db.prepare('SELECT body_html FROM forum_posts WHERE thread_id = ?').get(threadId);
  assert.doesNotMatch(stored.body_html, /<script/i);
  assert.doesNotMatch(stored.body_html, /onerror/i);
  assert.match(stored.body_html, /Hi/);
});

test('a private class forum is only visible to that class\'s staff/enrolled students/their parents', async () => {
  const admin = await loginAsMainAdmin();
  const classInfo = await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Art Studio')").run();
  const classId = classInfo.lastInsertRowid;

  const enrolledParent = await createParentAccount();
  const studentCode = await generateMemberCode();
  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Art Student', ?, ?, 'student', ?, 1)")
    .run(studentCode, studentCode, enrolledParent.familyId);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentInfo.lastInsertRowid);

  const outsiderParent = await createParentAccount();

  const catRes = await request(app)
    .post('/main-admin/forums')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Art Studio Forum', scope: 'class', classId: String(classId), _csrf: admin.csrfToken });
  assert.equal(catRes.status, 302);
  const category = await db.prepare("SELECT id FROM forum_categories WHERE name = 'Art Studio Forum'").get();

  const outsiderView = await request(app).get(`/forums/${category.id}`).set('Cookie', outsiderParent.cookie);
  assert.equal(outsiderView.status, 403);

  const enrolledView = await request(app).get(`/forums/${category.id}`).set('Cookie', enrolledParent.cookie);
  assert.equal(enrolledView.status, 200);
});

test('manage_forum lets a non-main_admin role moderate, and removal shows up for other viewers', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createGeneralCategory(admin);

  const author = await createParentAccount();
  const createRes = await request(app)
    .post(`/forums/${categoryId}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Needs moderation', body: '<p>Some content</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(createRes.headers.location)[1];
  const post = await db.prepare('SELECT id FROM forum_posts WHERE thread_id = ?').get(threadId);

  const nonModerator = await createParentAccount();
  const denied = await request(app).post(`/forums/threads/${threadId}/posts/${post.id}/remove`).set('Cookie', nonModerator.cookie).type('form').send({ _csrf: nonModerator.csrfToken });
  assert.equal(denied.status, 403);

  const moderatorParent = await createParentAccount({ grantForumModeration: true });
  const removed = await request(app).post(`/forums/threads/${threadId}/posts/${post.id}/remove`).set('Cookie', moderatorParent.cookie).type('form').send({ _csrf: moderatorParent.csrfToken });
  assert.equal(removed.status, 302);

  const view = await request(app).get(`/forums/threads/${threadId}`).set('Cookie', author.cookie);
  assert.doesNotMatch(view.text, /Some content/);
  assert.match(view.text, /removed by a moderator/);

  const logEntry = await db.prepare("SELECT * FROM forum_moderation_actions WHERE action = 'remove' AND target_id = ?").get(post.id);
  assert.ok(logEntry, 'expected a moderation log entry for the removal');
});

test('a locked thread rejects a reply from a non-moderator but allows one from a moderator', async () => {
  const admin = await loginAsMainAdmin();
  const categoryId = await createGeneralCategory(admin);
  const author = await createParentAccount();
  const createRes = await request(app)
    .post(`/forums/${categoryId}/threads`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ title: 'Will be locked', body: '<p>Original</p>', _csrf: author.csrfToken });
  const threadId = /\/forums\/threads\/(\d+)/.exec(createRes.headers.location)[1];

  const moderatorParent = await createParentAccount({ grantForumModeration: true });
  await request(app).post(`/forums/threads/${threadId}/lock`).set('Cookie', moderatorParent.cookie).type('form').send({ _csrf: moderatorParent.csrfToken });

  const blocked = await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', author.cookie)
    .type('form')
    .send({ body: '<p>Trying to reply</p>', _csrf: author.csrfToken });
  assert.match(decodeURIComponent(blocked.headers.location), /locked/);

  const allowed = await request(app)
    .post(`/forums/threads/${threadId}/posts`)
    .set('Cookie', moderatorParent.cookie)
    .type('form')
    .send({ body: '<p>Moderator reply</p>', _csrf: moderatorParent.csrfToken });
  assert.equal(allowed.status, 302);
});

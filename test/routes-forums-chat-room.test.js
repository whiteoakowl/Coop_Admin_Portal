// A real request: "main admin, chat tab, add chat room where people can
// talk to each other in a live continuous feed." A chat room is a
// forum_categories row with is_chat_room=1 and exactly one underlying
// thread (room_thread_id) - see utils/forums.js's own createCategory and
// routes/forums.js's/routes/admin-forums.js's redirect-straight-to-the-
// thread handling. This file covers that path specifically; test/routes-
// forums.test.js already covers the normal titled-thread chat groups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `forums-chat-room-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `forums-chat-room-test-uploads-${process.pid}`);
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
  const familyName = `Chat Room Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Chat Room Parent ${familyCounter}`, code, code, familyId);
  const email = `chatroomparent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/forums' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/forums').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

async function createChatRoom(admin, name) {
  const res = await request(app)
    .post('/main-admin/forums')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name, scope: 'general', isChatRoom: 'on', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  const category = await db.prepare('SELECT * FROM forum_categories WHERE name = ?').get(name);
  return category;
}

test('creating a chat room eagerly creates its one underlying thread', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Lounge');
  assert.equal(Number(category.is_chat_room), 1);
  assert.ok(category.room_thread_id, 'expected room_thread_id to be set');

  const thread = await db.prepare('SELECT * FROM forum_threads WHERE id = ?').get(category.room_thread_id);
  assert.ok(thread);
  assert.equal(thread.category_id, category.id);

  const postCount = await db.prepare('SELECT COUNT(*) AS c FROM forum_posts WHERE thread_id = ?').get(category.room_thread_id);
  assert.equal(Number(postCount.c), 0, 'a fresh chat room should start with no messages');
});

test('a normal chat group (not a chat room) gets no room_thread_id', async () => {
  const admin = await loginAsMainAdmin();
  const res = await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Regular Group', scope: 'general', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  const category = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Regular Group'").get();
  assert.equal(Number(category.is_chat_room), 0);
  assert.equal(category.room_thread_id, null);
});

test('member-facing: visiting a chat room category redirects straight to its one thread, skipping the thread list/new-thread flow', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Carpool Chat');
  const member = await createParentAccount();

  const catView = await request(app).get(`/forums/${category.id}`).set('Cookie', member.cookie);
  assert.equal(catView.status, 302);
  assert.equal(catView.headers.location, `/forums/threads/${category.room_thread_id}`);

  const newView = await request(app).get(`/forums/${category.id}/new`).set('Cookie', member.cookie);
  assert.equal(newView.status, 302);
  assert.equal(newView.headers.location, `/forums/threads/${category.room_thread_id}`);

  const postAttempt = await request(app)
    .post(`/forums/${category.id}/threads`)
    .set('Cookie', member.cookie)
    .type('form')
    .send({ title: 'Should not create a second thread', body: '<p>x</p>', _csrf: member.csrfToken });
  assert.equal(postAttempt.status, 302);
  assert.equal(postAttempt.headers.location, `/forums/threads/${category.room_thread_id}`);

  const threadCount = await db.prepare('SELECT COUNT(*) AS c FROM forum_threads WHERE category_id = ?').get(category.id);
  assert.equal(Number(threadCount.c), 1, 'a chat room must never grow a second thread');
});

test('the chat room thread page renders the Live Chat Room badge and a Send button, not Post Reply', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Badge Room');
  const member = await createParentAccount();

  const view = await request(app).get(`/forums/threads/${category.room_thread_id}`).set('Cookie', member.cookie);
  assert.equal(view.status, 200);
  assert.match(view.text, /Live Chat Room/);
  assert.match(view.text, />Send</);
  assert.doesNotMatch(view.text, />Post Reply</);
  assert.match(view.text, /chat-room-feed\.js/);
});

test('posting a message to a chat room thread works via the normal form submit (progressive enhancement baseline)', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Plain Post Room');
  const member = await createParentAccount();

  const res = await request(app)
    .post(`/forums/threads/${category.room_thread_id}/posts`)
    .set('Cookie', member.cookie)
    .type('form')
    .send({ body: '<p>Hello room</p>', _csrf: member.csrfToken });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/forums/threads/${category.room_thread_id}`);

  const view = await request(app).get(`/forums/threads/${category.room_thread_id}`).set('Cookie', member.cookie);
  assert.match(view.text, /Hello room/);
});

test('posting a message with Accept: application/json returns the new message as JSON instead of redirecting - the live feed\'s own AJAX path', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'AJAX Room');
  const member = await createParentAccount();

  const res = await request(app)
    .post(`/forums/threads/${category.room_thread_id}/posts`)
    .set('Cookie', member.cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ body: '<p>Live message</p>', _csrf: member.csrfToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.post, 'expected { post } in the JSON response');
  assert.match(res.body.post.body_html, /Live message/);
  assert.equal(res.body.post.authorName, `Chat Room Parent ${familyCounter}`);

  const stored = await db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(res.body.post.id);
  assert.ok(stored, 'the AJAX post must actually be persisted, not just echoed back');
});

test('feed.json returns every post in the thread for polling, and still enforces the same access check as the thread page', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Feed Room');
  const member = await createParentAccount();

  await request(app)
    .post(`/forums/threads/${category.room_thread_id}/posts`)
    .set('Cookie', member.cookie)
    .type('form')
    .send({ body: '<p>First message</p>', _csrf: member.csrfToken });

  const feed = await request(app).get(`/forums/threads/${category.room_thread_id}/feed.json`).set('Cookie', member.cookie);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.posts.length, 1);
  assert.match(feed.body.posts[0].body_html, /First message/);

  // A private class chat room's feed.json must deny a non-enrolled family,
  // same as the thread page itself (loadThread's own canAccessCategory
  // check) - this endpoint shares that same middleware, not a bypass.
  const classInfo = await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('wednesday', 2, 'Private Room Class')").run();
  const classRes = await request(app)
    .post('/main-admin/forums')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Private Class Room', scope: 'class', classId: String(classInfo.lastInsertRowid), isChatRoom: 'on', _csrf: admin.csrfToken });
  assert.equal(classRes.status, 302);
  const privateCategory = await db.prepare("SELECT * FROM forum_categories WHERE name = 'Private Class Room'").get();

  const outsider = await createParentAccount();
  const denied = await request(app).get(`/forums/threads/${privateCategory.room_thread_id}/feed.json`).set('Cookie', outsider.cookie);
  assert.equal(denied.status, 403);
});

test('admin-facing: opening a chat room category from the Chat Groups list goes straight to its thread view (no thread-list page in between)', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createChatRoom(admin, 'Admin View Room');

  const catView = await request(app).get(`/main-admin/forums/${category.id}`).set('Cookie', admin.cookie);
  assert.equal(catView.status, 302);
  assert.equal(catView.headers.location, `/main-admin/forums/threads/${category.room_thread_id}`);

  const threadView = await request(app).get(`/main-admin/forums/threads/${category.room_thread_id}`).set('Cookie', admin.cookie);
  assert.equal(threadView.status, 200);
  assert.match(threadView.text, /Live Chat Room/);
});

test('the Chat Groups list shows a Live Chat Room badge for a chat room and not for a normal group', async () => {
  const admin = await loginAsMainAdmin();
  await createChatRoom(admin, 'Badge List Room');
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name: 'Badge List Group', scope: 'general', _csrf: admin.csrfToken });

  const listView = await request(app).get('/main-admin/forums?tab=new').set('Cookie', admin.cookie);
  assert.match(listView.text, /Badge List Room[\s\S]*?Live Chat Room/);
  const groupSection = listView.text.split('Badge List Group')[1] || '';
  assert.doesNotMatch(groupSection.split('</div>')[0], /Live Chat Room/);
});

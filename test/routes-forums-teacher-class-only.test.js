// Real HTTP-level coverage for a real request: "Teacher portal chat will
// only have class chats." A teacher-ONLY account (no other portal role -
// a teacher who's also a Parent, the real "self-signed-up to also teach
// a class" case, keeps full access to general chat as a parent, same
// reasoning middleware/portalAuth.js's blockTeacherOnlyAccounts uses)
// only ever sees/reaches 'class' scope chat categories through the one
// shared /forums route - never 'general' ones, whether from the Chat
// list or a direct URL to a general category/thread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `forums-teacher-class-only-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `forums-teacher-class-only-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');
const forums = require('../utils/forums');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function addRole(accountId, roleKey) {
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
}

async function makeClass(name) {
  return (await db.prepare('INSERT INTO classes (day, hour_position, class_name) VALUES (?, ?, ?) RETURNING id').get('monday', 1, name)).id;
}

async function loginTeacher(email, { alsoParent = false } = {}) {
  const classId = await makeClass(`${email} Class`);
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Class Chat Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  await addRole(accountId, 'teacher');
  if (alsoParent) await addRole(accountId, 'parent');
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return { cookie: loginRes.headers['set-cookie'], classId };
}

test('a teacher-only account only sees class chats, never general ones', async (t) => {
  const generalId = await forums.createCategory({ name: 'General Water Cooler', scope: 'general' });
  const { cookie, classId } = await loginTeacher('class-chat-teacher-only@example.com');
  const classCategoryId = await forums.createCategory({ name: 'My Class Chat', scope: 'class', classId });

  await t.test('the Chat list only shows the class category, not the general one', async () => {
    const res = await request(app).get('/forums').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /My Class Chat/);
    assert.doesNotMatch(res.text, /General Water Cooler/);
  });

  await t.test('a direct URL to the general category is still blocked, not just hidden from the list', async () => {
    const res = await request(app).get(`/forums/${generalId}`).set('Cookie', cookie);
    assert.equal(res.status, 403);
  });

  await t.test('the class category itself is reachable', async () => {
    const res = await request(app).get(`/forums/${classCategoryId}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
  });
});

test('an account that is BOTH teacher and parent still sees general chats too', async (t) => {
  const generalId = await forums.createCategory({ name: 'General Chat For Dual Role', scope: 'general' });
  const { cookie } = await loginTeacher('class-chat-teacher-parent@example.com', { alsoParent: true });

  await t.test('the Chat list shows the general category', async () => {
    const res = await request(app).get('/forums').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /General Chat For Dual Role/);
  });

  await t.test('a direct URL to the general category works', async () => {
    const res = await request(app).get(`/forums/${generalId}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
  });
});

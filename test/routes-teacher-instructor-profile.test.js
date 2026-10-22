// Coverage for Co-op Teacher Portal > Instructor Profile self-edit - a real
// request: "Teachers can edit their instructor profile on the teacher
// portal if they are given permission to view that portal and if their
// profile has been enabled." (routes/teacher-portal.js's own GET/POST
// /teacher/instructor-profile). Reaching this router at all already
// proves "given permission to view that portal" (router.use(
// requirePortalAuth, requirePortal('teacher')) in routes/teacher-
// portal.js - untested here, covered by the many other Co-op Teacher Portal
// test files); this file covers the other half - the admin-only
// enabled flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-instructor-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-instructor-profile-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');
const { setInstructorProfileEnabled } = require('../utils/instructorProfiles');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let teacherCounter = 0;
async function loginTeacher() {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Instructor Profile Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  const email = `instructor-profile-teacher-${teacherCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/teacher').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { memberId, cookie, csrfToken };
}

test('Co-op Teacher Portal nav offers an Instructor Profile link', async () => {
  const { cookie } = await loginTeacher();
  const res = await request(app).get('/teacher').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<a href="\/teacher\/instructor-profile">[\s\S]*?Instructor Profile<\/a>/);
});

test('a not-yet-enabled profile shows a message instead of the edit form, and a direct POST is refused', async () => {
  const { memberId, cookie, csrfToken } = await loginTeacher();

  const res = await request(app).get('/teacher/instructor-profile').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /hasn't been enabled yet/);
  assert.doesNotMatch(res.text, /name="aboutMe"/);

  await request(app)
    .post('/teacher/instructor-profile')
    .set('Cookie', cookie)
    .type('form')
    .send({ email: 'sneaky@example.com', _csrf: csrfToken });
  const row = await db.prepare('SELECT * FROM instructor_profiles WHERE member_id = ?').get(memberId);
  assert.ok(!row || !row.email, 'a POST while disabled should not be able to write profile fields');
});

test('once an admin enables the profile, the teacher can view and save their own bio', async (t) => {
  const { memberId, cookie, csrfToken } = await loginTeacher();
  await setInstructorProfileEnabled(memberId, true);

  await t.test('the edit form is now shown', async () => {
    const res = await request(app).get('/teacher/instructor-profile').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /hasn't been enabled yet/);
    assert.match(res.text, /name="aboutMe"/);
    assert.match(res.text, /name="qualificationsVisible"/);
  });

  await t.test('saving writes every field but never touches enabled', async () => {
    await request(app)
      .post('/teacher/instructor-profile')
      .set('Cookie', cookie)
      .type('form')
      .send({
        email: 'myself@example.com',
        phone: '555-9876',
        aboutMe: 'Self-written bio.',
        qualifications: 'Masters in Education',
        qualificationsVisible: '1',
        _csrf: csrfToken,
      });

    const row = await db.prepare('SELECT * FROM instructor_profiles WHERE member_id = ?').get(memberId);
    assert.equal(row.email, 'myself@example.com');
    assert.equal(row.phone, '555-9876');
    assert.equal(row.about_me, 'Self-written bio.');
    assert.equal(row.qualifications, 'Masters in Education');
    assert.equal(Number(row.qualifications_visible), 1);
    assert.equal(Number(row.enabled), 1, 'a teacher saving their own bio should never be able to change the admin-only enabled flag');

    const page = await request(app).get('/teacher/instructor-profile').set('Cookie', cookie);
    assert.match(page.text, /value="myself@example\.com"/);
    assert.match(page.text, /Self-written bio\./);
  });
});

test('an admin disabling the profile mid-session blocks a further self-edit POST', async () => {
  const { memberId, cookie, csrfToken } = await loginTeacher();
  await setInstructorProfileEnabled(memberId, true);
  await setInstructorProfileEnabled(memberId, false);

  await request(app)
    .post('/teacher/instructor-profile')
    .set('Cookie', cookie)
    .type('form')
    .send({ aboutMe: 'Should not save.', _csrf: csrfToken });

  const row = await db.prepare('SELECT * FROM instructor_profiles WHERE member_id = ?').get(memberId);
  assert.ok(!row.about_me, 'a POST after being re-disabled should not write');
});

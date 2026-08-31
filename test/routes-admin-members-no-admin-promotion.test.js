// Real HTTP-level coverage for a real request: "Choosing admins should
// not be on the membership profile, co-op admin portal. It should be on
// main admin member list edit only." / "Admin roles is only chosen
// under settings in main admin portal."
//
// Two halves:
// 1. partials/member-form-fields.ejs (Co-op Admin's own Add/Edit Member
//    form) never renders a way to pick "Admin" - covered here by
//    checking the rendered HTML has no such radio for a non-admin
//    member.
// 2. routes/admin-members.js's own POST /members/:id/edit rejects a
//    memberType='admin' submission for a member who isn't already
//    admin (defense-in-depth for a raw request that skips the form),
//    and never silently demotes an existing admin who submits a
//    non-admin memberType through this same route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-members-no-admin-promo-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-members-no-admin-promo-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin member form never offers Admin as a choosable type', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Promo Student', 'No Promo Student', 'student')")
    .run();

  await t.test('a Parent/Student member\'s edit form only offers Parent/Student radios', async () => {
    const res = await request(app).get(`/admin/members/${studentId}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /<input type="radio" name="memberType" value="admin"/);
    assert.match(res.text, /<input type="radio" name="memberType" value="parent"/);
    assert.match(res.text, /<input type="radio" name="memberType" value="student"/);
  });

  await t.test('submitting memberType=admin through this route does NOT promote the member', async () => {
    const page = await request(app).get(`/admin/members/${studentId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    await request(app)
      .post(`/admin/members/${studentId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'No Promo Student', memberType: 'admin', _csrf: csrfToken });

    const member = await db.prepare('SELECT member_type FROM members WHERE id = ?').get(studentId);
    assert.notEqual(member.member_type, 'admin', 'a raw memberType=admin submission must not promote the member');
  });
});

test('an existing Admin member keeps their type when other fields are edited via Co-op Admin', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: adminId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Existing Admin Member', 'Existing Admin Member', 'admin')")
    .run();

  await t.test('the edit form shows Admin as a fixed, disabled indicator (not a pickable Parent/Student toggle)', async () => {
    const res = await request(app).get(`/admin/members/${adminId}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<input type="radio" name="memberType" value="admin" checked disabled/);
    assert.doesNotMatch(res.text, /<input type="radio" name="memberType" value="parent"/);
    assert.doesNotMatch(res.text, /<input type="radio" name="memberType" value="student"/);
  });

  await t.test('editing the phone number keeps member_type as admin', async () => {
    const page = await request(app).get(`/admin/members/${adminId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    const res = await request(app)
      .post(`/admin/members/${adminId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Existing Admin Member', phone: '555-1234', _csrf: csrfToken });
    assert.equal(res.status, 302);

    const member = await db.prepare('SELECT member_type, phone FROM members WHERE id = ?').get(adminId);
    assert.equal(member.member_type, 'admin', 'still Admin - not silently demoted just because the form has no memberType=admin radio to submit');
    assert.equal(member.phone, '555-1234');
  });

  await t.test('a spoofed memberType=student submission for this member is also ignored', async () => {
    const page = await request(app).get(`/admin/members/${adminId}/edit`).set('Cookie', cookie);
    const csrfToken = extractCsrf(page.text);
    await request(app)
      .post(`/admin/members/${adminId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Existing Admin Member', memberType: 'student', _csrf: csrfToken });

    const member = await db.prepare('SELECT member_type FROM members WHERE id = ?').get(adminId);
    assert.equal(member.member_type, 'admin', 'demoting away from Admin is also not allowed through this route');
  });
});

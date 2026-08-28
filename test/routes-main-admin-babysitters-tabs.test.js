// Coverage for Main Admin > Babysitters restructure (item 15) - a real
// request: "babysitter tab should have babysitter, approvals and
// settings tab. add a babysitter profile button that pops up and picks a
// member, auto fills the rest of the form. directory should be cards,
// alphabetical by last name, with photo, name, grade and phone number.
// add a call or text preference field." Parent/Student self-submission
// is unchanged and already covered elsewhere - this file checks the new
// Main Admin surface: the 3 tabs, admin-added profiles landing approved
// immediately, the Settings toggle actually changing member-submission
// behavior, and the directory card/member-picker markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-babysitters-tabs-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-babysitters-tabs-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/babysitters').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function seedStudentMember(suffix, { grade = '9th Grade', phone = '555-0100' } = {}) {
  const familyId = (await db.prepare(`INSERT INTO families (name) VALUES ('Sitter Family ${suffix}') RETURNING id`).get()).id;
  const member = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, active, grade_level, phone) VALUES (?, ?, 'student', ?, 1, ?, ?) RETURNING id")
    .get(`Zzz Sitter ${suffix}`, `sitter-${suffix}`, familyId, grade, phone);
  return member.id;
}

test('Babysitters page: Babysitter/Approvals/Settings tabs all render', async () => {
  const { cookie } = await loginAsMainAdmin();
  const directoryPage = await request(app).get('/main-admin/babysitters').set('Cookie', cookie);
  assert.equal(directoryPage.status, 200);
  assert.match(directoryPage.text, /class="view-tab active" href="\/main-admin\/babysitters\?tab=directory">Babysitter</);
  assert.match(directoryPage.text, /href="\/main-admin\/babysitters\?tab=approvals">Approvals/);
  assert.match(directoryPage.text, /href="\/main-admin\/babysitters\?tab=settings">Settings/);
  assert.match(directoryPage.text, />\+ Add Babysitter Profile</);

  const settingsPage = await request(app).get('/main-admin/babysitters?tab=settings').set('Cookie', cookie);
  assert.match(settingsPage.text, /class="view-tab active" href="\/main-admin\/babysitters\?tab=settings">Settings</);
  assert.match(settingsPage.text, /name="requireApproval"/);
});

test('Add Babysitter Profile popup: member picker carries grade/phone data attributes for autofill, and submitting lands the profile approved immediately', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await seedStudentMember('A', { grade: '9th Grade', phone: '555-0101' });

  const page = await request(app).get('/main-admin/babysitters').set('Cookie', cookie);
  assert.match(page.text, new RegExp(`<option value="${memberId}" data-grade="9th Grade" data-phone="555-0101">`));

  const res = await request(app)
    .post('/main-admin/babysitters')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken, memberId: String(memberId), ageGrade: '9th Grade', contactPreference: 'text' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const profile = await db.prepare('SELECT * FROM babysitter_profiles WHERE member_id = ?').get(memberId);
  assert.ok(profile);
  assert.equal(profile.status, 'approved');
  assert.ok(profile.decided_at);
  assert.equal(profile.contact_preference, 'text');

  const directoryPage = await request(app).get('/main-admin/babysitters').set('Cookie', cookie);
  assert.match(directoryPage.text, /Zzz Sitter A/);
  assert.match(directoryPage.text, /555-0101/);
  assert.match(directoryPage.text, /Text/);
});

test('Settings: turning off "require approval" makes a member self-submission land approved instead of pending', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await seedStudentMember('B');

  const settingsRes = await request(app)
    .post('/main-admin/babysitters/settings')
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken });
  assert.equal(settingsRes.status, 302);

  const babysitters = require('../utils/babysitters');
  assert.equal(await babysitters.requireApprovalSetting(), false);

  await babysitters.submitProfile(memberId, { ageGrade: '10th Grade', contactPreference: 'call' }, null);
  const profile = await db.prepare('SELECT * FROM babysitter_profiles WHERE member_id = ?').get(memberId);
  assert.equal(profile.status, 'approved');

  await babysitters.setRequireApprovalSetting(true);
});

test('Approvals tab shows pending submissions with approve/reject actions', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const memberId = await seedStudentMember('C');

  const babysitters = require('../utils/babysitters');
  await babysitters.submitProfile(memberId, { ageGrade: '11th Grade' }, null);

  const page = await request(app).get('/main-admin/babysitters?tab=approvals').set('Cookie', cookie);
  assert.match(page.text, /Zzz Sitter C/);
  assert.match(page.text, /Approvals \(1\)/);

  const profile = await db.prepare('SELECT * FROM babysitter_profiles WHERE member_id = ?').get(memberId);
  const approveRes = await request(app)
    .post(`/main-admin/babysitters/${profile.id}/approve`)
    .type('form')
    .set('Cookie', cookie)
    .send({ _csrf: csrfToken });
  assert.equal(approveRes.status, 302);

  const decided = await db.prepare('SELECT * FROM babysitter_profiles WHERE id = ?').get(profile.id);
  assert.equal(decided.status, 'approved');
});

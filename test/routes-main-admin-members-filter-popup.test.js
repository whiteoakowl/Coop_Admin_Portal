// Coverage for a real request: "Main admin portal, members, filter
// dropdown should change to an orange buttons with a popup." Replaces
// the old plain <select> (views/partials/members-type-filter.ejs) with a
// Filter button opening a dialog - same shape as the Member Schedules
// page's own Filter (views/admin-schedule.ejs). Also covers a real
// improvement this unlocked: the old dropdown could only ever pick ONE
// of Type or Family (alternate options in the same flat list);
// utils/members.js's own membersWithDetails already ANDs both together
// when given, so the new dialog's Type radio group + separate Family
// select, submitted together, can combine them for the first time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-filter-popup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-filter-popup-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('the Members page has a Filter button (not a plain dropdown) that opens a dialog with Type radios and a Family select', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Filter Popup Family') RETURNING id").get()).id;

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<select id="type-select"/);
  assert.match(page.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)">/);
  assert.match(page.text, /<dialog id="members-filter-dialog" class="member-picker-dialog">/);
  assert.match(page.text, /<input type="radio" name="type" value="parent"/);
  assert.match(page.text, /<input type="radio" name="type" value="student"/);
  assert.match(page.text, /<input type="radio" name="type" value="admin"/);
  assert.match(page.text, new RegExp(`<option value="${familyId}"[^>]*>Filter Popup Family Family</option>`));
});

test('the Filter button label and the dialog pre-select the currently applied Type and Family together', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Preselect Family') RETURNING id").get()).id;

  const res = await request(app).get(`/main-admin/members?tab=members&type=student&family=${familyId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Filter: Student, Preselect Family Family/);
  assert.match(res.text, /<input type="radio" name="type" value="student" checked/);
  assert.match(res.text, new RegExp(`<option value="${familyId}" selected>Preselect Family Family</option>`));
});

test('combining Type and Family in one submission filters the member list by both at once', async () => {
  const cookie = await loginAsMainAdmin();
  const familyA = (await db.prepare("INSERT INTO families (name) VALUES ('Combo Family A') RETURNING id").get()).id;
  const familyB = (await db.prepare("INSERT INTO families (name) VALUES ('Combo Family B') RETURNING id").get()).id;
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Student In A', 'student-in-a', 'student', ?)").run(familyA);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Parent In A', 'parent-in-a', 'parent', ?)").run(familyA);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Student In B', 'student-in-b', 'student', ?)").run(familyB);

  const res = await request(app).get(`/main-admin/members?tab=members&type=student&family=${familyA}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Student In A/);
  assert.doesNotMatch(res.text, /Parent In A/, 'Type=student should exclude a parent in the same family');
  assert.doesNotMatch(res.text, /Student In B/, 'Family=A should exclude a student in a different family');
});

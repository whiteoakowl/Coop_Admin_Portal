// A real request on the Member Profile's Schedule tab (both Co-op Admin
// and Main Admin): "each family member's schedule for all days should
// be in one card. Family member name as title in card... print all
// schedules should say print schedules and should be at the top of the
// page." Main Admin's own coverage - Co-op Admin's equivalent is
// test/routes-members-schedule-view-all.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-schedule-card-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-schedule-card-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff } = require('../utils/classSchedule');

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

test('Main Admin member profile Schedule tab "View All": one card per family member, name as its title, Print Schedules at the top', async () => {
  const cookie = await loginAsMainAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Schedule Card Test Family') RETURNING id").get()).id;
  const parentInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Schedule Card Parent', 'schedule-card-parent', 'parent', ?, 1)").run(familyId);
  const studentInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Schedule Card Student', 'schedule-card-student', 'student', ?, 1)").run(familyId);

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Schedule Card Test Class', startTime: '9:00 AM', endTime: '9:45 AM' });
  await addStaff(classId, parentInfo.lastInsertRowid, 'teacher');
  await setEnrollment(classId, [studentInfo.lastInsertRowid]);

  const res = await request(app).get(`/main-admin/members/${parentInfo.lastInsertRowid}?tab=schedule&family=all`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Schedule Card Test Class/);

  assert.match(res.text, />Print Schedules</);
  assert.doesNotMatch(res.text, /Print All Schedules/);
  const printBtnIdx = res.text.indexOf('>Print Schedules<');
  const firstCardIdx = res.text.indexOf('member-profile-family-schedule-card');
  assert.ok(printBtnIdx > -1 && firstCardIdx > -1 && printBtnIdx < firstCardIdx, 'Print Schedules should come before the family members\' own cards');

  // Each member is one .form-section card, their name as its own <h2>.
  const cardRe = /<div class="form-section member-profile-family-schedule-card">\s*<h2 class="member-profile-family-schedule-name">([^<]+)<\/h2>/g;
  const names = [...res.text.matchAll(cardRe)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['Schedule Card Parent', 'Schedule Card Student']);

  // No more per-day .form-section cards nested inside - just one card
  // per member, holding both days' tables.
  assert.doesNotMatch(res.text, /<div class="form-section member-profile-family-schedule-card">[\s\S]*?<div class="form-section">/);
});

// Coverage for the Members tab's Class Schedule "View All" feature: the
// Family Member dropdown gets an "All" choice that shows every family
// member's schedule on the profile page, and its Print link renders a
// compact one-row-per-member table (routes/admin-schedule.js's /schedule/
// print with a familyId filter, admin-schedule-print.ejs's compact mode)
// instead of the normal one-full-card-per-member layout - a family of
// even 3-4 people already runs the normal layout well past one printed
// page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `members-schedule-view-all-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `members-schedule-view-all-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Members Class Schedule tab: "View All" and its compact family print', async (t) => {
  const cookie = await loginAsAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('View All Test Family')").run()).lastInsertRowid;
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('View All Parent', 'view-all-parent', 'parent', ?)").run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('View All Student', 'view-all-student', 'student', ?)").run(familyId)
  ).lastInsertRowid;
  const otherFamilyId = (await db.prepare("INSERT INTO families (name) VALUES ('Other Family')").run()).lastInsertRowid;
  const otherParentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Other Family Parent', 'other-family-parent', 'parent', ?)").run(otherFamilyId)
  ).lastInsertRowid;

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'View All Test Class', startTime: '9:00 AM', endTime: '9:45 AM' });
  await addStaff(classId, parentId, 'teacher');
  await setEnrollment(classId, [studentId]);

  await t.test('the dropdown offers an "All" option', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /<option value="all"[^>]*>All<\/option>/);
  });

  await t.test('family=all shows both family members\' schedules on the page', async () => {
    const res = await request(app).get(`/admin/members/${parentId}?tab=schedule&family=all`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /View All Parent/);
    assert.match(res.text, /View All Student/);
    assert.match(res.text, /View All Test Class/);
    assert.match(res.text, /Print All Schedules/);
    assert.match(res.text, new RegExp(`/admin/schedule/print\\?familyId=${familyId}`));
  });

  await t.test('the compact family print shows a stacked name-above-schedule section per family member, not the other family\'s parent', async () => {
    const res = await request(app).get(`/admin/schedule/print?familyId=${familyId}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    // A real bug report ("bleeds off the page... put the name above each
    // members class schedule section") replaced the old shared 3-column
    // (Name/Monday/Wednesday) table with a stacked section per member -
    // see admin-schedule-print.ejs's own comment on why.
    assert.match(res.text, /schedule-print-member-section/, 'expected the stacked name-above-schedule section layout, not the old name-column table');
    assert.doesNotMatch(res.text, /schedule-print-compact-table/);
    assert.match(res.text, /View All Parent/);
    assert.match(res.text, /View All Student/);
    assert.match(res.text, /View All Test Class/);
    assert.doesNotMatch(res.text, /Other Family Parent/, 'a different family\'s member must not appear in this family\'s print');
    // The normal per-member card layout must NOT also render alongside it.
    assert.doesNotMatch(res.text, /schedule-print-card/);
  });

  await t.test('a solo member (no family) never gets the "All" option', async () => {
    const res = await request(app).get(`/admin/members/${otherParentId}?tab=schedule`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /<option value="all"/);
  });
});

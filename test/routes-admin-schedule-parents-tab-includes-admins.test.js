// Real bug report: "when viewing parent schedules under parent tab it
// won't show admins. wherever there is a parent filter it should include
// admins too." routes/admin-schedule.js's Parent-filtered Member
// Schedules view (GET /admin/schedule?tab=members&type=parent, since
// merged into one Member Schedules tab with a Filter popup - see the
// ?tab=students/parents redirect at the top of that route) used to build
// its card grid AND its jump-to-a-name dropdown from a hardcoded
// member_type = 'parent' filter, so an admin/leader member - who can
// teach, assist, floater, or staff a team just like any other adult -
// never showed up there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-parents-admins-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-parents-admins-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('old ?tab=parents / ?tab=students bookmarks redirect to the merged Member Schedules tab with the matching type filter, memberId preserved', async () => {
  const cookie = await loginAsAdmin();
  const admin = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Redirect Test Admin', 'redirect-sched-1', 'admin', 1)").run()).lastInsertRowid;

  const parentsRes = await request(app).get('/admin/schedule?tab=parents').set('Cookie', cookie).redirects(0);
  assert.equal(parentsRes.status, 302);
  assert.match(parentsRes.headers.location, /tab=members/);
  assert.match(parentsRes.headers.location, /type=parent/);

  const studentsRes = await request(app).get(`/admin/schedule?tab=students&memberId=${admin}`).set('Cookie', cookie).redirects(0);
  assert.equal(studentsRes.status, 302);
  assert.match(studentsRes.headers.location, /tab=members/);
  assert.match(studentsRes.headers.location, /type=student/);
  assert.match(studentsRes.headers.location, new RegExp(`memberId=${admin}`), 'other query params like memberId should carry through the redirect');
});

test('Parent Schedules tab lists admin/leader members alongside parents, both in the card grid and the jump-to-name dropdown', async () => {
  const cookie = await loginAsAdmin();

  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Coleader Adminson', 'admin-sched-1', 'admin', 1)").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Parentworth Regular', 'admin-sched-2', 'parent', 1)").run();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Studently Young', 'admin-sched-3', 'student', 1)").run();

  const res = await request(app).get('/admin/schedule?tab=members&type=parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Coleader Adminson/, 'an admin member should appear on the Parent Schedules tab');
  assert.match(res.text, /Parentworth Regular/, 'a real parent should still appear too');
  assert.doesNotMatch(res.text, /Studently Young/, 'students still belong on the Student Schedules tab, not this one');
});

test('Parent Schedules tab: selecting an admin by memberId filters the grid down to just them', async () => {
  const cookie = await loginAsAdmin();
  const admin = await db.prepare("SELECT id FROM members WHERE name = 'Coleader Adminson'").get();

  const parentworth = await db.prepare("SELECT id FROM members WHERE name = 'Parentworth Regular'").get();
  const res = await request(app).get(`/admin/schedule?tab=members&type=parent&memberId=${admin.id}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  // archive-select-checkbox is only ever rendered once per row in the
  // (filtered) card grid itself - unlike allNames' own hidden
  // archive-offpage-checkbox, which intentionally still lists every
  // active parent/admin regardless of the memberId filter (see its own
  // comment in the view) so "select all across every page" keeps working.
  assert.match(res.text, new RegExp(`class="archive-select-checkbox[^>]*value="${admin.id}"|value="${admin.id}"[^>]*class="archive-select-checkbox`));
  assert.doesNotMatch(
    res.text,
    new RegExp(`class="archive-select-checkbox[^>]*value="${parentworth.id}"|value="${parentworth.id}"[^>]*class="archive-select-checkbox`),
    'filtering to one admin member should narrow the card grid to just them, the same as it would for a parent'
  );
});

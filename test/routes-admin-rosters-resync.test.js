// Coverage for a live bug report: a family's non-primary parent, auto-
// added to a day's Parent roster before the primary-parent-only scoping
// fix landed (see utils/classSchedule.js's primaryParentIdsByFamily),
// stayed on the roster forever because syncDayMemberRosters only reruns
// reactively on an actual enrollment/staffing/floater edit - a family
// nobody happened to touch since the fix kept showing the stale result.
// Adds a "Resync" button (POST /admin/rosters/:day/resync) that reruns
// the same sync on demand, so an admin isn't stuck waiting for or faking
// a throwaway edit just to force a day's rosters to recompute.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-resync-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-resync-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'] };
}

test('POST /admin/rosters/:day/resync clears a stale non-primary-parent auto entry and keeps a manual one', async () => {
  const { cookie } = await loginAsAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Resync Family')").run()).lastInsertRowid;
  const primaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Primary Resync Parent', 'resync-primary', 'parent', ?, 1)")
      .run(familyId)
  ).lastInsertRowid;
  const staleParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Stale Resync Parent', 'resync-stale', 'parent', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Resync Kid', 'resync-kid', 'student', ?)").run(familyId)
  ).lastInsertRowid;
  const manualParentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Manually Added Parent', 'resync-manual', 'parent')").run()
  ).lastInsertRowid;

  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Resync Class' });
  await setEnrollment(classId, [studentId]);

  const parentRosterId = await ensureDayRoster('monday', 'parent');
  // Simulate the stale, pre-fix state directly - a non-primary parent
  // sitting on the roster as an 'auto' entry (as the old, unscoped logic
  // would have put them), plus a parent an admin explicitly added by
  // hand via + Add Member ('manual'), unrelated to this family.
  await db
    .prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'auto') ON CONFLICT (roster_id, member_id) DO NOTHING")
    .run(parentRosterId, staleParentId);
  await db
    .prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING")
    .run(parentRosterId, manualParentId);

  const page = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post('/admin/rosters/monday/resync')
    .set('Cookie', cookie)
    .type('form')
    .send({ tab: 'monday-parent', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /tab=monday-parent/);
  assert.match(res.headers.location, /notice=/);

  const memberIds = (await db.prepare('SELECT member_id FROM roster_members WHERE roster_id = ?').all(parentRosterId)).map((r) => r.member_id);
  assert.ok(memberIds.includes(primaryParentId), 'the family\'s primary parent should be on the roster after resync');
  assert.ok(!memberIds.includes(staleParentId), 'the stale auto-added non-primary parent should be removed by resync');
  assert.ok(memberIds.includes(manualParentId), 'a manually-added parent must survive resync untouched');
});

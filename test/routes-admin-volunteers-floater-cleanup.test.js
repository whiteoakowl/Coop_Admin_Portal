// Coverage for a live bug report: Floater Teams accumulated both parents
// from many families (one hour section alone had ~101 members) - the
// primary-parent-only rule only stops NEW auto-assignments
// (autoAssignFloatersForDay), and volunteer_members has no 'source'
// column the way roster_members does, so nothing ever automatically
// removed a non-primary parent added under old logic or a bulk import.
// Adds an explicit, confirm-guarded cleanup action (POST
// /admin/volunteers/:day/teams/cleanup ->
// removeNonPrimaryParentsFromFloaterTeams in utils/classSchedule.js) an
// admin can run themselves to fix the existing data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-floater-cleanup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-floater-cleanup-test-uploads-${process.pid}`);
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
  return { cookie: loginRes.headers['set-cookie'] };
}

test('POST /admin/volunteers/:day/teams/cleanup removes non-primary parents but leaves the primary parent and family-less parents alone', async (t) => {
  const { cookie } = await loginAsAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Floater Cleanup Family')").run()).lastInsertRowid;
  const primaryParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Primary Floater Parent', 'floater-primary', 'parent', ?, 1)")
      .run(familyId)
  ).lastInsertRowid;
  const spouseParentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Spouse Floater Parent', 'floater-spouse', 'parent', ?)")
      .run(familyId)
  ).lastInsertRowid;
  const noFamilyParentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Family Floater Parent', 'floater-no-family', 'parent')").run()
  ).lastInsertRowid;

  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const section = await db.prepare('SELECT id FROM volunteer_sections WHERE volunteer_list_id = ? ORDER BY position LIMIT 1').get(list.id);
  for (const memberId of [primaryParentId, spouseParentId, noFamilyParentId]) {
    await db
      .prepare("INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id, rank) VALUES (?, ?, ?, 'sometimes')")
      .run(list.id, memberId, section.id);
  }

  const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app).post('/admin/volunteers/monday/teams/cleanup').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Removed%201/);

  const remaining = (await db.prepare('SELECT member_id FROM volunteer_members WHERE volunteer_list_id = ? AND section_id = ?').all(list.id, section.id)).map(
    (r) => r.member_id
  );
  assert.ok(remaining.includes(primaryParentId), 'the primary parent should stay');
  assert.ok(!remaining.includes(spouseParentId), 'the non-primary spouse should be removed');
  assert.ok(remaining.includes(noFamilyParentId), 'a parent with no family on file has nothing to compare against, so must be left alone');

  await t.test('running it again is a harmless no-op', async () => {
    const again = await request(app).post('/admin/volunteers/monday/teams/cleanup').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(again.status, 302);
    assert.match(again.headers.location, /notice=No%20non-primary/);
  });
});

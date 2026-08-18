// Real bug report: "when deleting members off the floater lists the
// member isn't removed." Root cause: routes/admin-volunteers.js's remove
// route deletes the volunteer_members row, then calls
// syncDayMemberRosters(day) to keep the day's Parent/Student rosters in
// sync - but that same sync unconditionally re-runs utils/classSchedule.
// js's autoAssignFloatersForDay first, which re-derives "should this
// family's primary parent float this hour" from scratch (their family's
// attendance window that hour overlaps, and they have no class of their
// own then) and puts them right back in, on the SAME request as the
// removal. This reproduces the exact real-world trigger: a family whose
// student is enrolled in a class that hour, so the parent gets
// auto-floated there, and confirms an explicit removal via the real admin
// route now actually sticks - including across a later, unrelated sync.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `floater-remove-sticks-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `floater-remove-sticks-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, syncDayMemberRosters } = require('../utils/classSchedule');
const { getListByDay, sectionsForList } = require('../utils/volunteers');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('removing a member from a Floater Teams hour actually sticks, even though it was auto-assigned there', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Remove Sticks Family')").run()).lastInsertRowid;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Remove Sticks Parent', 'remove-sticks-parent', 'parent', ?, 1)")
      .run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Remove Sticks Kid', 'remove-sticks-kid', 'student', ?)")
      .run(familyId)
  ).lastInsertRowid;

  // The student's own class at hour 1 gives their family an attendance
  // window covering hour 1 - exactly what makes the primary parent an
  // auto-assign candidate for hour 1's own floater section, since they
  // have no class of their own that hour.
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Remove Sticks Class', startTime: '9:00 AM', endTime: '10:00 AM' });
  await setEnrollment(classId, [studentId]);

  const list = await getListByDay('monday');
  const hour1 = (await sectionsForList(list.id)).find((s) => s.position === 1);

  await t.test('sanity check: the primary parent really did get auto-floated onto hour 1', async () => {
    await syncDayMemberRosters('monday');
    const row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').get(list.id, parentId, hour1.id);
    assert.ok(row, 'auto-assign should have placed the primary parent on hour 1 - otherwise this test isn\'t reproducing the real bug');
  });

  await t.test('removing them via the real admin route actually removes them, not just for one page load', async () => {
    const res = await request(app)
      .post(`/admin/volunteers/monday/teams/${hour1.id}/members/${parentId}/remove`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Removed from team/);

    const row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').get(list.id, parentId, hour1.id);
    assert.equal(row, undefined, 'the removal itself should have taken - this is the literal bug report: it wasn\'t');

    const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
    // "Remove Sticks Parent" still legitimately appears elsewhere on the
    // page (the "+ Add Member" dialog's own <option> list, now that
    // they're available to add again) - the member ROW inside the hour 1
    // card itself is what has to be gone.
    assert.doesNotMatch(page.text, /team-member-name"[^]*?Remove Sticks Parent/, 'the member should be gone from the rendered card too');
    assert.match(page.text, /No floaters assigned to this hour yet\./);
  });

  await t.test('an unrelated later sync does not silently bring them back', async () => {
    await syncDayMemberRosters('monday');
    const row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').get(list.id, parentId, hour1.id);
    assert.equal(row, undefined, 'a later sync (the exact trigger this bug came from) must not re-add them');
  });

  await t.test('but a deliberate re-add through the real "+ Add Member" route wins over the past removal and stays put', async () => {
    await request(app)
      .post('/admin/volunteers/monday/teams/add-member')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberId: String(parentId), sectionId: String(hour1.id), _csrf: csrfToken });

    let row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').get(list.id, parentId, hour1.id);
    assert.ok(row, 'the explicit re-add should have taken');

    await syncDayMemberRosters('monday');
    row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').get(list.id, parentId, hour1.id);
    assert.ok(row, 'a deliberate re-add must survive a later sync too - it should have cleared the old exclusion, not left it in place');
  });
});

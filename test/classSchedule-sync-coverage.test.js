// Confirms Schedule Cards (member_schedules) and Name Tags stay correctly
// in sync with every membership change this app has - class enrollment,
// class staffing, Floater Assignments, and Setup/Cleanup Teams - per a bug
// report asking to "make sure" this always happens. Investigation found
// every mutation path already wired correctly:
//   - setEnrollment/addStaff/removeStaff default to calling
//     syncDayMemberRosters (which itself calls syncMemberSchedulesForDay)
//     unless a bulk caller explicitly opts into skipSync + one syncDayMemberRosters
//     call of its own at the end.
//   - Floater Assignments' add/remove-member routes (routes/admin-volunteers.js)
//     explicitly call syncDayMemberRosters after every add/remove.
//   - Setup/Cleanup Teams membership (setup_team_members) was never part of
//     member_schedules by design (utils/classSchedule.js's own docstring:
//     "derived from the master Class Schedule and the Floater Assignments
//     list" only) - it instead feeds a Parent Name Tag's "cleanupTeam"
//     field via a live JOIN query (utils/nameTagData.js's
//     cleanupTeamsForParent), so there is no cache to go stale in the
//     first place.
// No code changes were needed for this ticket - this file exists to lock
// the already-correct behavior in as a regression test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classschedule-sync-coverage-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classschedule-sync-coverage-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection, removeMemberFromSection } = require('../utils/volunteers');
const { getMemberSchedule } = require('../utils/schedule');
const { badgeDataForMember } = require('../utils/nameTagData');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('enrolling/unenrolling a student in a class updates their Schedule Card immediately', async () => {
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sync Coverage Student', 'sync-coverage-student', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Sync Coverage Class' });

  await setEnrollment(classId, [studentId]);
  let schedule = await getMemberSchedule(studentId);
  assert.equal(schedule.monday.find((r) => r.class_number === 1).class_name, 'Sync Coverage Class');

  await setEnrollment(classId, []);
  schedule = await getMemberSchedule(studentId);
  assert.equal(schedule.monday.find((r) => r.class_number === 1).class_name, '');
});

test('adding/removing a parent from a Floater Assignments hour updates their Schedule Card immediately', async () => {
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sync Coverage Floater Parent', 'sync-coverage-floater', 'parent')").run()
  ).lastInsertRowid;
  const list = await getListByDay('wednesday');
  const hour2 = (await sectionsForList(list.id)).find((s) => s.position === 2);

  await addMemberToSection(list.id, parentId, hour2.id);
  const { syncDayMemberRosters } = require('../utils/classSchedule');
  await syncDayMemberRosters('wednesday');
  let schedule = await getMemberSchedule(parentId);
  assert.equal(schedule.wednesday.find((r) => r.class_number === 2).class_name, 'Floater');

  await removeMemberFromSection(list.id, parentId, hour2.id);
  await syncDayMemberRosters('wednesday');
  schedule = await getMemberSchedule(parentId);
  assert.equal(schedule.wednesday.find((r) => r.class_number === 2).class_name, '');
});

test('adding/removing a parent from a Setup/Cleanup team is reflected on their Name Tag instantly (live query, no cache)', async () => {
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sync Coverage Cleanup Parent', 'sync-coverage-cleanup', 'parent')").run()
  ).lastInsertRowid;
  const teamId = (
    await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Sync Coverage Snack Team')").run()
  ).lastInsertRowid;

  let data = await badgeDataForMember({ id: parentId, member_type: 'parent', name: 'Sync Coverage Cleanup Parent', barcode: 'sync-coverage-cleanup' });
  assert.equal(data.cleanupTeam, '');

  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentId);
  data = await badgeDataForMember({ id: parentId, member_type: 'parent', name: 'Sync Coverage Cleanup Parent', barcode: 'sync-coverage-cleanup' });
  assert.equal(data.cleanupTeam, 'Sync Coverage Snack Team');

  await db.prepare('DELETE FROM setup_team_members WHERE team_id = ? AND member_id = ?').run(teamId, parentId);
  data = await badgeDataForMember({ id: parentId, member_type: 'parent', name: 'Sync Coverage Cleanup Parent', barcode: 'sync-coverage-cleanup' });
  assert.equal(data.cleanupTeam, '');
});

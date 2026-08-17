// Coverage for a real live bug report: bulk-printing ~800 cards timed out.
// Traced to three separate N+1 query patterns that only showed up at real
// co-op scale (invisible in a one-or-two-member manual test):
//   1. utils/nameTagData.js's badgeDataForMember ran a fresh cleanup-team
//      query per PARENT.
//   2. utils/scheduleCardData.js's scheduleCardDataForMember ran a fresh
//      getMemberSchedule call per member unless a precomputed schedule was
//      passed in.
//   3. scheduleCardDataForMember ALSO ran primaryParentFor (two sequential
//      queries) per STUDENT regardless of whether a schedule was
//      precomputed - never fixed anywhere before this, even in the one
//      route that had already fixed #2.
// Fixed via batch siblings (badgeDataForMembers/cleanupTeamsForParents,
// schedulesForMembers, scheduleCardDataForMembers/primaryParentsFor) that
// each run their underlying query ONCE for a whole selection instead of
// once per member, now used by every bulk print route (routes/admin-
// name-tag.js's /name-tag/print, routes/admin-schedule.js's
// /schedule/print-cards and its Student/Parent Schedules grid, and
// utils/cardPairs.js's buildCardPairs, shared by routes/admin-design.js's
// /design/print-both and /design/print-duplex).
//
// This file proves two things for a single mixed batch (multiple parents
// with different cleanup teams, a family with a primary and a secondary
// parent, students with and without allergies, a member with no family at
// all) printed together in one request:
//   - the batched helpers produce byte-identical data to the old
//     per-member functions for the same input (no behavior regression from
//     the refactor), and
//   - each member's own data lands on their own card, not a neighbor's
//     (the real risk in any "compute once, look up per id" batching - a
//     keying bug would silently swap two members' allergies/phones/teams).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `bulk-print-batch-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `bulk-print-batch-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff } = require('../utils/classSchedule');
const { badgeDataForMember, badgeDataForMembers } = require('../utils/nameTagData');
const { scheduleCardDataForMember, scheduleCardDataForMembers } = require('../utils/scheduleCardData');
const { getMemberSchedule, schedulesForMembers } = require('../utils/schedule');
const { buildCardPairs } = require('../utils/cardPairs');

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

async function insertMember(fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map(() => '?').join(',');
  const info = await db.prepare(`INSERT INTO members (${cols.join(',')}) VALUES (${placeholders})`).run(...cols.map((c) => fields[c]));
  return info.lastInsertRowid;
}

test('a mixed batch: bulk-batched helpers match their per-member counterparts, keyed correctly per member', async () => {
  // A family with a primary and secondary parent, and a student with an
  // allergy.
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Batch Family')").run()).lastInsertRowid;
  const primaryParentId = await insertMember({
    name: 'Primary Parent', barcode: 'batch-primary-parent', member_type: 'parent', family_id: familyId, is_primary_parent: 1, phone: '555-1111',
  });
  const secondaryParentId = await insertMember({
    name: 'Secondary Parent', barcode: 'batch-secondary-parent', member_type: 'parent', family_id: familyId, phone: '555-2222',
  });
  const studentId = await insertMember({
    name: 'Allergy Student', barcode: 'batch-allergy-student', member_type: 'student', family_id: familyId, medical_notes: 'Peanut allergy',
  });

  // A lone student, no family at all - primaryParentFor/primaryParentsFor
  // should both come back with nothing for this one.
  const loneStudentId = await insertMember({ name: 'Lone Student', barcode: 'batch-lone-student', member_type: 'student' });

  // Two more parents, each on a different cleanup team, plus one parent on
  // no team at all - cleanupTeamsForParent(s) needs to tell all three
  // apart.
  const teamAId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Chairs & Tables')").run()).lastInsertRowid;
  const teamBId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('wednesday', 'Snack Table')").run()).lastInsertRowid;
  const teamAParentId = await insertMember({ name: 'Team A Parent', barcode: 'batch-team-a-parent', member_type: 'parent' });
  const teamBParentId = await insertMember({ name: 'Team B Parent', barcode: 'batch-team-b-parent', member_type: 'parent' });
  const noTeamParentId = await insertMember({ name: 'No Team Parent', barcode: 'batch-no-team-parent', member_type: 'parent' });
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamAId, teamAParentId);
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamBId, teamBParentId);

  // Give the two family students a real, distinct Monday schedule so
  // schedulesForMembers has something non-blank to batch and mis-key.
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes: ['9:00 AM', '', '', ''], endTimes: ['9:45 AM', '', '', ''], _csrf: csrfToken });
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Batch Class', room: 'Room B' });
  await setEnrollment(classId, [studentId]);
  await addStaff(classId, primaryParentId, 'teacher');

  const allMembers = await db
    .prepare(
      `SELECT * FROM members WHERE id IN (?, ?, ?, ?, ?, ?, ?) ORDER BY LOWER(name)`
    )
    .all(primaryParentId, secondaryParentId, studentId, loneStudentId, teamAParentId, teamBParentId, noTeamParentId);

  // --- badgeDataForMembers vs badgeDataForMember, member by member ---
  const badgeBatch = await badgeDataForMembers(allMembers);
  for (const member of allMembers) {
    assert.deepEqual(badgeBatch[member.id], await badgeDataForMember(member), `badgeDataForMembers should match badgeDataForMember for ${member.name}`);
  }
  assert.equal(badgeBatch[teamAParentId].cleanupTeam, 'Chairs & Tables');
  assert.equal(badgeBatch[teamBParentId].cleanupTeam, 'Snack Table');
  assert.equal(badgeBatch[noTeamParentId].cleanupTeam, '', 'a parent on no team should get an empty string, not another parent\'s team');
  assert.equal(badgeBatch[studentId].allergies, 'Peanut allergy');
  assert.equal(badgeBatch[loneStudentId].allergies, '', 'a student with no allergy on file should get an empty string, not a neighbor\'s');

  // --- schedulesForMembers vs getMemberSchedule, member by member ---
  // (schedulesForMembers deliberately omits the unused lastUpdated field
  // getMemberSchedule still carries - see its own "Returns" comment - so
  // only monday/wednesday are compared here.)
  const scheduleBatch = await schedulesForMembers(allMembers.map((m) => m.id));
  for (const member of allMembers) {
    const { monday, wednesday } = await getMemberSchedule(member.id);
    assert.deepEqual(scheduleBatch[member.id], { monday, wednesday }, `schedulesForMembers should match getMemberSchedule for ${member.name}`);
  }
  assert.equal(scheduleBatch[studentId].monday[0].class_name, 'Batch Class');
  assert.equal(scheduleBatch[loneStudentId].monday[0].class_name, '', 'a member with no classes should get blank rows, not a neighbor\'s class');

  // --- scheduleCardDataForMembers vs scheduleCardDataForMember, member by member ---
  const cardDataBatch = await scheduleCardDataForMembers(allMembers, scheduleBatch);
  for (const member of allMembers) {
    assert.deepEqual(
      cardDataBatch[member.id],
      await scheduleCardDataForMember(member, scheduleBatch[member.id]),
      `scheduleCardDataForMembers should match scheduleCardDataForMember for ${member.name}`
    );
  }
  assert.equal(cardDataBatch[studentId].primaryParentPhone, 'Parent Phone: 555-1111', 'should surface the family\'s PRIMARY parent, not whichever parent comes first');
  assert.equal(cardDataBatch[loneStudentId].primaryParentPhone, '', 'a student with no family at all should get no phone line, not a neighbor\'s');
  assert.equal(cardDataBatch[primaryParentId].primaryParentPhone, '', 'a parent\'s own card never shows a phone line');

  // --- buildCardPairs end to end: every member gets their own two cards ---
  const pairs = await buildCardPairs(allMembers);
  const studentPair = pairs.find((p) => p.name === 'Allergy Student');
  assert.match(studentPair.scheduleCard.html, /Peanut allergy/);
  assert.match(studentPair.scheduleCard.html, /555-1111/);
  const loneStudentPair = pairs.find((p) => p.name === 'Lone Student');
  assert.doesNotMatch(loneStudentPair.scheduleCard.html, /Peanut allergy/, 'the lone student\'s card must not pick up a neighbor\'s allergy');
  assert.doesNotMatch(loneStudentPair.scheduleCard.html, /555-1111/, 'the lone student\'s card must not pick up a neighbor\'s parent phone');
});

test('the bulk print routes render every member of a mixed batch correctly (HTTP level)', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/name-tag').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const parentId = await insertMember({ name: 'Route Parent', barcode: 'batch-route-parent', member_type: 'parent' });
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Route Team')").run()).lastInsertRowid;
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, parentId);
  const studentId = await insertMember({
    name: 'Route Student', barcode: 'batch-route-student', member_type: 'student', medical_notes: 'Tree nut allergy',
  });

  const nameTagRes = await request(app)
    .post('/admin/name-tag/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: [parentId, studentId], _csrf: csrfToken });
  assert.equal(nameTagRes.status, 200);
  assert.match(nameTagRes.text, /Route Team/, 'the parent\'s name tag should show their cleanup team');

  const scheduleCardRes = await request(app)
    .post('/admin/schedule/print-cards')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: [parentId, studentId], _csrf: csrfToken });
  assert.equal(scheduleCardRes.status, 200);
  assert.match(scheduleCardRes.text, /Tree nut allergy/, 'the student\'s schedule card should show their allergy');

  const bothRes = await request(app)
    .post('/admin/design/print-both')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: [parentId, studentId], _csrf: csrfToken });
  assert.equal(bothRes.status, 200);
  assert.match(bothRes.text, /Route Team/);
  assert.match(bothRes.text, /Tree nut allergy/);
});

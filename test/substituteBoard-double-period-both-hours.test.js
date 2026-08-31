// A real request: "if a teacher or assistant is absent for a 2 time slot
// class like forest Wildlings, preschool, prek, kinder, dnd, cooking etc.
// then the position should appear on the floater list both hours the
// class takes place." Before this, a double-period class's own missing-
// teacher/assistant slot only ever reached the ONE hour it's literally
// filed under (gridForDay's own hour_position bucket) - see
// utils/substitutes.js's own classStaffByHour, which now reuses
// classSchedule.js's floaterPositionsCoveredByClass (the same overlap
// logic classSchedule-double-period-floater-overlap.test.js already
// covers for floater-list clearing) to also surface the slot on every
// OTHER hour the class's own real time genuinely runs through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-double-period-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-double-period-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, addStaff } = require('../utils/classSchedule');
const { substituteBoard, classStaffSlotId, dailyAssignmentCardsWithLabels, publicFloaterCardsForDate, archivedDateSummaries } = require('../utils/substitutes');

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

async function setHourTimes(cookie, day, startTimes, endTimes) {
  const page = await request(app).get(`/admin/schedule?tab=${day}`).set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post(`/admin/class-schedule/${day}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes, endTimes, _csrf: csrfToken });
}

test('a double-period class\'s missing-teacher slot appears on substituteBoard for BOTH hours it spans, sharing one assignment', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  // Hour 1: 9:00-9:45, Hour 2: 9:45-10:30 - Forest Wildlings is filed
  // under Hour 1 but its own end_time (10:30) runs into Hour 2 too.
  await setHourTimes(cookie, day, ['9:00 AM', '9:45 AM', '', ''], ['9:45 AM', '10:30 AM', '', '']);

  const classId = await createClass({
    day, hourPosition: 1, className: 'Forest Wildlings', room: 'Field', startTime: '9:00 AM', endTime: '10:30 AM',
  });
  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Double Period Teacher', 'double-period-teacher', 'parent')").run()
  ).lastInsertRowid;
  await addStaff(classId, teacherId, 'teacher');

  const date = '2026-09-07'; // a Monday
  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Double Period Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(teacherId, rosterId, date);

  const board = await substituteBoard(day, date);
  const slotId = classStaffSlotId(classId, teacherId);

  const hour1Slot = board.find((h) => h.position === 1).slots.find((s) => s.slotType === 'class' && s.slotId === slotId);
  const hour2Slot = board.find((h) => h.position === 2).slots.find((s) => s.slotType === 'class' && s.slotId === slotId);
  assert.ok(hour1Slot, 'the class\'s own hour should list the missing-teacher slot');
  assert.ok(hour2Slot, 'the second hour the class actually runs through should list it too');
  assert.equal(hour1Slot.reason, 'Teacher absent: Double Period Teacher');
  assert.equal(hour2Slot.reason, 'Teacher absent: Double Period Teacher');

  // Neither hour 3 nor hour 4 (never touched by this class) should pick it up.
  assert.equal(board.find((h) => h.position === 3).slots.some((s) => s.slotId === slotId), false);
  assert.equal(board.find((h) => h.position === 4).slots.some((s) => s.slotId === slotId), false);

  // Approving a sub for hour 1's card should show as the SAME assignment
  // on hour 2's card too - one floater covers the whole double period.
  const { setAssignment } = require('../utils/substitutes');
  const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
  const list = await getListByDay(day);
  const hour1Section = (await sectionsForList(list.id)).find((s) => s.position === 1);
  const sub = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Double Period Sub', 'double-period-sub', 'parent')").run()).lastInsertRowid;
  await addMemberToSection(list.id, sub, hour1Section.id);
  await setAssignment(date, 'class', slotId, sub, true);

  const boardAfter = await substituteBoard(day, date);
  const hour1After = boardAfter.find((h) => h.position === 1).slots.find((s) => s.slotId === slotId);
  const hour2After = boardAfter.find((h) => h.position === 2).slots.find((s) => s.slotId === slotId);
  assert.equal(hour1After.assigned.id, sub);
  assert.equal(hour2After.assigned.id, sub, 'the approved sub should show on the second hour\'s card too, same underlying assignment');
  assert.equal(hour1After.assigned.status, 'approved');
  assert.equal(hour2After.assigned.status, 'approved');
});

test('the Archive tab (dailyAssignmentCardsWithLabels) and the public kiosk view both surface the same double-period slot on both hours, and archivedDateSummaries counts it twice', async () => {
  const cookie = await loginAsAdmin();
  const day = 'wednesday';
  await setHourTimes(cookie, day, ['1:00 PM', '1:45 PM', '', ''], ['1:45 PM', '2:30 PM', '', '']);

  const classId = await createClass({
    day, hourPosition: 1, className: 'Cooking Club', room: 'Kitchen', startTime: '1:00 PM', endTime: '2:30 PM',
  });
  const assistantId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cooking Assistant', 'cooking-assistant', 'parent')").run()
  ).lastInsertRowid;
  await addStaff(classId, assistantId, 'assistant');

  const date = '2026-09-09'; // a Wednesday
  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Cooking Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(assistantId, rosterId, date);

  const { setAssignment } = require('../utils/substitutes');
  const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
  const list = await getListByDay(day);
  const hour1Section = (await sectionsForList(list.id)).find((s) => s.position === 1);
  const sub = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Cooking Sub', 'cooking-sub', 'parent')").run()).lastInsertRowid;
  await addMemberToSection(list.id, sub, hour1Section.id);
  await setAssignment(date, 'class', classStaffSlotId(classId, assistantId), sub, true);

  const archiveCards = await dailyAssignmentCardsWithLabels(day, date);
  const archiveHour1 = archiveCards.find((h) => h.position === 1);
  const archiveHour2 = archiveCards.find((h) => h.position === 2);
  assert.ok(archiveHour1.jobs.some((j) => j.title === 'Cooking Club'), 'Archive tab should show it on hour 1');
  assert.ok(archiveHour2.jobs.some((j) => j.title === 'Cooking Club'), 'Archive tab should show it on hour 2 too');

  const kioskCards = await publicFloaterCardsForDate(day, date);
  const kioskHour1 = kioskCards.find((h) => h.position === 1);
  const kioskHour2 = kioskCards.find((h) => h.position === 2);
  assert.ok(kioskHour1.jobs.some((j) => j.title === 'Cooking Club'), 'public kiosk should show it on hour 1');
  assert.ok(kioskHour2.jobs.some((j) => j.title === 'Cooking Club'), 'public kiosk should show it on hour 2 too');

  const [summary] = await archivedDateSummaries(day, [date]);
  assert.equal(summary.totalPositions, 2, 'the double-period slot should count once per hour it actually spans');
  assert.equal(summary.assignedCount, 2, 'the same approved sub should count as filled for both hours');
});

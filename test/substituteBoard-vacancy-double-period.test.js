// A real bug report: "now its not showing 2 hour classes on the floater
// list that are missing a teacher." A double-period class's own standing
// vacancy (teacher_slots/assistant_slots set, nobody signed up - see
// classVacancyEntriesForClass in utils/substitutes.js) used to only ever
// land under the class's own single hour_position bucket (classVacancySlots
// iterated gridForDay's own per-hour classes list directly, with none of
// the overlap expansion classStaffByHour already gave the "missing-
// teacher-TODAY" slot type - see substituteBoard-double-period-both-
// hours.test.js). So a real 2-hour class short a teacher silently vanished
// from the SECOND hour's chart, even though the class actually runs
// through both. Fixed by classVacancySlotsByHour, which reuses the same
// floaterPositionsCoveredByClass overlap logic classStaffByHour already
// uses, so a vacancy now fans out across every hour the class spans, the
// same as a missing-teacher-today slot does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `substituteboard-vacancy-double-period-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `substituteboard-vacancy-double-period-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const {
  substituteBoard,
  classVacancySlotId,
  dailyAssignmentCardsWithLabels,
  publicFloaterCardsForDate,
  archivedDateSummaries,
} = require('../utils/substitutes');

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

test('a double-period class\'s standing vacancy (unfilled teacher_slots) appears on substituteBoard for BOTH hours it spans, sharing one assignment', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  // Hour 1: 11:00-11:45, Hour 2: 11:45-12:30 - Preschool is filed under
  // Hour 1 but its own end_time (12:30) runs into Hour 2 too.
  await setHourTimes(cookie, day, ['', '', '11:00 AM', '11:45 AM'], ['', '', '11:45 AM', '12:30 PM']);

  const classId = await createClass({
    day, hourPosition: 3, className: 'Preschool Vacancy Class', room: 'Room P', startTime: '11:00 AM', endTime: '12:30 PM', teacherSlots: 1,
  });

  const date = '2026-09-07'; // a Monday
  const slotId = classVacancySlotId(classId, 'teacher', 1);

  const board = await substituteBoard(day, date);
  const hour3Slot = board.find((h) => h.position === 3).slots.find((s) => s.slotType === 'vacancy' && s.slotId === slotId);
  const hour4Slot = board.find((h) => h.position === 4).slots.find((s) => s.slotType === 'vacancy' && s.slotId === slotId);
  assert.ok(hour3Slot, 'the class\'s own hour should list the vacancy');
  assert.ok(hour4Slot, 'the second hour the class actually runs through should list it too');
  assert.equal(hour3Slot.reason, 'Teacher needed (0 of 1 filled)');
  assert.equal(hour4Slot.reason, 'Teacher needed (0 of 1 filled)');

  // Neither hour 1 nor hour 2 (never touched by this class) should pick it up.
  assert.equal(board.find((h) => h.position === 1).slots.some((s) => s.slotId === slotId), false);
  assert.equal(board.find((h) => h.position === 2).slots.some((s) => s.slotId === slotId), false);

  // Approving a floater for hour 3's card should show as the SAME
  // assignment on hour 4's card too - one floater covers the whole double
  // period.
  const { setAssignment } = require('../utils/substitutes');
  const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
  const list = await getListByDay(day);
  const hour3Section = (await sectionsForList(list.id)).find((s) => s.position === 3);
  const floater = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Vacancy Double Period Floater', 'vacancy-double-period-floater', 'parent')").run()).lastInsertRowid;
  await addMemberToSection(list.id, floater, hour3Section.id);
  await setAssignment(date, 'vacancy', slotId, floater, true);

  const boardAfter = await substituteBoard(day, date);
  const hour3After = boardAfter.find((h) => h.position === 3).slots.find((s) => s.slotId === slotId);
  const hour4After = boardAfter.find((h) => h.position === 4).slots.find((s) => s.slotId === slotId);
  assert.equal(hour3After.assigned.id, floater);
  assert.equal(hour4After.assigned.id, floater, 'the approved floater should show on the second hour\'s card too, same underlying assignment');
  assert.equal(hour3After.assigned.status, 'approved');
  assert.equal(hour4After.assigned.status, 'approved');
});

test('the Archive tab, the public kiosk view, and archivedDateSummaries also surface a double-period vacancy on both hours', async () => {
  const cookie = await loginAsAdmin();
  const day = 'wednesday';
  await setHourTimes(cookie, day, ['', '2:00 PM', '2:45 PM', ''], ['', '2:45 PM', '3:30 PM', '']);

  const classId = await createClass({
    day, hourPosition: 2, className: 'DnD Vacancy Class', room: 'Library', startTime: '2:00 PM', endTime: '3:30 PM', assistantSlots: 1,
  });

  const date = '2026-09-09'; // a Wednesday
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const { setAssignment } = require('../utils/substitutes');
  const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');
  const list = await getListByDay(day);
  const hour2Section = (await sectionsForList(list.id)).find((s) => s.position === 2);
  const floater = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('DnD Vacancy Floater', 'dnd-vacancy-floater', 'parent')").run()).lastInsertRowid;
  await addMemberToSection(list.id, floater, hour2Section.id);
  await setAssignment(date, 'vacancy', slotId, floater, true);

  const archiveCards = await dailyAssignmentCardsWithLabels(day, date);
  const archiveHour2 = archiveCards.find((h) => h.position === 2);
  const archiveHour3 = archiveCards.find((h) => h.position === 3);
  assert.ok(archiveHour2.jobs.some((j) => j.title === 'DnD Vacancy Class'), 'Archive tab should show it on hour 2');
  assert.ok(archiveHour3.jobs.some((j) => j.title === 'DnD Vacancy Class'), 'Archive tab should show it on hour 3 too');

  const kioskCards = await publicFloaterCardsForDate(day, date);
  const kioskHour2 = kioskCards.find((h) => h.position === 2);
  const kioskHour3 = kioskCards.find((h) => h.position === 3);
  assert.ok(kioskHour2.jobs.some((j) => j.title === 'DnD Vacancy Class'), 'public kiosk should show it on hour 2');
  assert.ok(kioskHour3.jobs.some((j) => j.title === 'DnD Vacancy Class'), 'public kiosk should show it on hour 3 too');

  const [summary] = await archivedDateSummaries(day, [date]);
  assert.equal(summary.totalPositions, 2, 'the double-period vacancy should count once per hour it actually spans');
  assert.equal(summary.assignedCount, 2, 'the same approved floater should count as filled for both hours');
});

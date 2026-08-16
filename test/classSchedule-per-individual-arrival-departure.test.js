// Coverage for an explicit design change: Arrival/Departure used to be a
// FAMILY-WIDE window (every family member's own commitments merged into
// one shared value - see the original "Family-based arrival/departure"
// work), on the theory that a parent isn't leaving before their kid does.
// Live testing found this actively wrong for the actual ask: a parent's
// own Departure should reflect only THEIR OWN last hour of teaching/
// assisting/floating, and a student's own Departure should reflect only
// THEIR OWN last class - computed independently per person, never merged
// across a family. familyAttendanceWindowsForDay (utils/classSchedule.js)
// now only ever folds in a member's OWN ownRangesByMember entries, not a
// windowByFamily lookup.
//
// Note: ownPositionsAndFamilyWindowsForDay's own windowByFamily is left
// family-wide on purpose (explicitly confirmed, not an oversight) -
// autoAssignFloatersForDay still deliberately uses it to decide which of
// a parent's blank hours to auto-float even when the parent has no class
// of their own that day (an earlier, separate feature request -
// "Auto-assign parents to floater team hours for blank schedule gaps").
// Once auto-assign places a parent into an hour for that reason, floating
// it is a real commitment of their own and correctly extends their own
// Departure (see the first test below, which verifies exactly this
// combination) - this is the two features correctly working together,
// not family-merging leaking back into the arrival/departure computation
// itself. The second test keeps the parent and student unrelated (no
// shared family) so that interaction can't apply at all, isolating the
// plain per-individual computation on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `per-individual-arrival-departure-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `per-individual-arrival-departure-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment, addStaff, syncDayMemberRosters } = require('../utils/classSchedule');
const { arrivalDepartureLabels } = require('../utils/schedule');

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

async function setHours(cookie, day, startTimes, endTimes) {
  const page = await request(app).get(`/admin/schedule?tab=${day}`).set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post(`/admin/class-schedule/${day}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes, endTimes, _csrf: csrfToken });
}

test('a parent auto-floated into a blank hour because their kid is enrolled there gets a departure that reflects that REAL floater commitment - not a family-merged guess', async () => {
  const { cookie } = await loginAsAdmin();
  await setHours(cookie, 'monday', ['9:00 AM', '', '', '12:00 PM'], ['9:45 AM', '', '', '12:45 PM']);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Per-Individual Family')").run()).lastInsertRowid;
  const parentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Per-Individual Parent', 'per-individual-parent', 'parent', ?)").run(familyId)
  ).lastInsertRowid;
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Per-Individual Kid', 'per-individual-kid', 'student', ?)").run(familyId)
  ).lastInsertRowid;

  const hour1Class = await createClass({ day: 'monday', hourPosition: 1, className: 'Parent Teaches' });
  await addStaff(hour1Class, parentId, 'teacher');
  const hour4Class = await createClass({ day: 'monday', hourPosition: 4, className: 'Kid Last Class' });
  await setEnrollment(hour4Class, [studentId]);
  await syncDayMemberRosters('monday');

  const parentLabels = await arrivalDepartureLabels(parentId, 'monday');
  const studentLabels = await arrivalDepartureLabels(studentId, 'monday');

  // autoAssignFloatersForDay (family-wide, unchanged - explicitly kept
  // that way) auto-floats the primary parent into every blank hour within
  // the family's combined window, so this parent is now a REAL Hour 4
  // floater, not just "family-adjacent." Their departure legitimately
  // reflects that - this is the two features working together correctly,
  // not the old family-merged Arrival/Departure bug reappearing.
  assert.deepEqual(parentLabels, { arrival: '9:00 AM', departure: '12:45 PM' }, 'the parent\'s own real Hour 4 floater assignment (auto-added because of their kid) should count toward their own departure');
  assert.deepEqual(studentLabels, { arrival: '12:00 PM', departure: '12:45 PM' }, 'the kid\'s own window must not be pulled earlier by the parent\'s unrelated Hour 1 class');
});

test('two unrelated members each get their own independent window - no cross-family bleed', async () => {
  const { cookie } = await loginAsAdmin();
  await setHours(cookie, 'wednesday', ['9:00 AM', '', '', '12:00 PM'], ['9:45 AM', '', '', '12:45 PM']);

  const parentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Solo Parent', 'solo-parent', 'parent')").run()).lastInsertRowid;
  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Solo Student', 'solo-student', 'student')").run()).lastInsertRowid;

  const hour1Class = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Solo Parent Class' });
  await addStaff(hour1Class, parentId, 'teacher');
  const hour4Class = await createClass({ day: 'wednesday', hourPosition: 4, className: 'Solo Student Class' });
  await setEnrollment(hour4Class, [studentId]);
  await syncDayMemberRosters('wednesday');

  const parentLabels = await arrivalDepartureLabels(parentId, 'wednesday');
  const studentLabels = await arrivalDepartureLabels(studentId, 'wednesday');

  assert.deepEqual(parentLabels, { arrival: '9:00 AM', departure: '9:45 AM' });
  assert.deepEqual(studentLabels, { arrival: '12:00 PM', departure: '12:45 PM' });
});

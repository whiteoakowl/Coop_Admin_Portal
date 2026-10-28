// Real HTTP-level coverage for a real request: "if someone submits an
// absence form and they are currently assigned as a floater, it should
// automatically unassign them." routes/absence.js's own /absence/submit
// handler calls utils/substitutes.js's unassignMemberForDate right after
// actually recording a member absent/late for a date, clearing any
// substitute_assignments row they hold on that same date - same "compute
// once, act on read" trigger point classSchedule.js's own
// absenceFormAbsentMemberIdsForDate comment describes ("a 'late'
// submission means they still won't be at their usual spot on time, so
// the automated sub system shouldn't count on them for a floater slot
// that day either"), just now an active DELETE instead of a passive
// exclusion from suggestions.
//
// A later real request reversed an earlier deliberate choice here: "if
// someone is manually marked absent after checking in it should mark
// them absent everywhere, including setup/cleanup and unassign them to
// their floater positions." routes/absence.js used to skip a roster
// entirely once its attendance row already read 'present' (meant to
// protect a real same-day check-in from a stale/mistaken form) - but
// that silently dropped the whole submission: the attendance row never
// flipped, so it never surfaced as absent on the Setup/Cleanup roster or
// the Floater board, and the absence_submissions insert sitting on that
// same skipped code path meant it never even reached the Attendance
// page's own Alerts box or the Home dashboard's Alert Log either (both
// read a live attendance row with source = 'absence_form' - see utils/
// alerts.js). A manually-submitted absence/late now always overrides
// whatever the live attendance row currently says, and also clears any
// setup_task_assignments row via utils/setup.js's unassignMemberTasksForDate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `absence-auto-unassign-floater-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `absence-auto-unassign-floater-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { createPermanentJob, setAssignment } = require('../utils/substitutes');
const { absenceFormAlertsForDay, absenceFormSubmissionsForRoster } = require('../utils/alerts');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

const today = todayISO();

test('submitting an Absence form for a member currently assigned as a floater automatically unassigns them', async (t) => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Floater Then Absent Parent', 'Floater Then Absent Parent', 'parent')")
    .run();
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);

  const jobId = await createPermanentJob({ day: 'monday', hourPosition: 1, title: 'Front Desk Floater Job' });
  await setAssignment(today, 'job', jobId, memberId, false);

  await t.test('the member holds the floater assignment before submitting', async () => {
    const row = await db.prepare('SELECT member_id FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(today, 'job', jobId);
    assert.equal(row.member_id, memberId);
  });

  await t.test('submitting the absence form clears that floater assignment', async () => {
    const res = await request(app)
      .post('/absence/submit')
      .type('form')
      .send({
        type: 'absence',
        parentId: String(memberId),
        studentIds: String(memberId),
        sessionDate: today,
        reasonCategory: 'personal',
        reason: 'family trip',
      });
    assert.equal(res.status, 200);

    const attendance = await db.prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, roster.id, today);
    assert.equal(attendance.status, 'absent');

    const row = await db.prepare('SELECT member_id FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(today, 'job', jobId);
    assert.equal(row, undefined, 'the floater assignment should be cleared, not just left stale');
  });
});

// A real request: "if someone is manually marked absent after checking
// in it should mark them absent everywhere, including setup/cleanup and
// unassign them to their floater positions." Submitting the form after a
// real same-day check-in now overrides 'present' rather than leaving it
// (and everything downstream of it) untouched.
test('a member already checked in as present IS marked absent, unassigned from their floater job, and unassigned from their setup/cleanup task by a later absence submission', async () => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Present Floater Parent', 'Present Floater Parent', 'parent')")
    .run();
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, ?, 'present', 'kiosk', ?)`)
    .run(memberId, roster.id, today, Date.now());

  const jobId = await createPermanentJob({ day: 'monday', hourPosition: 2, title: 'Already Present Floater Job' });
  await setAssignment(today, 'job', jobId, memberId, false);

  // A real Setup/Cleanup task assignment for the same member/date -
  // task_item_id left null since this test only cares that the whole
  // row gets cleared, not which task it pointed at.
  await db
    .prepare("INSERT INTO setup_task_assignments (day, member_id, session_date, semester_id) VALUES ('monday', ?, ?, NULL)")
    .run(memberId, today);

  const res = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({
      type: 'absence',
      parentId: String(memberId),
      studentIds: String(memberId),
      sessionDate: today,
      reasonCategory: 'personal',
      reason: 'marked absent after already checking in',
    });
  assert.equal(res.status, 200);

  const attendance = await db.prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, roster.id, today);
  assert.equal(attendance.status, 'absent', 'a manual absence submission now overrides an already-present status');
  assert.equal(attendance.source, 'absence_form');

  const floaterRow = await db.prepare('SELECT member_id FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(today, 'job', jobId);
  assert.equal(floaterRow, undefined, 'the floater assignment should be cleared even though the member had already checked in present');

  const setupRow = await db.prepare('SELECT * FROM setup_task_assignments WHERE member_id = ? AND session_date = ?').get(memberId, today);
  assert.equal(setupRow, undefined, 'the setup/cleanup task assignment should be cleared the same way the floater assignment is');
});

// A real request: "Absence form submitted after checking in for the
// same day should still show up on the attendance notification list at
// the bottom of the page." utils/alerts.js's absenceFormAlertsForDay/
// absenceFormSubmissionsForRoster both drive that list (the Attendance
// page's own Alerts box and the Home dashboard's Alert Log) by reading a
// live attendance row with source = 'absence_form' - before this fix
// that row never existed once the member had already checked in present,
// so the submission was invisible there even though it visibly "worked."
test('an absence form submitted after checking in still shows up on the Attendance page Alerts box and the dashboard Alert Log', async () => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Already Checked In Alert Parent', 'Already Checked In Alert Parent', 'parent')")
    .run();
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, ?, 'present', 'kiosk', ?)`)
    .run(memberId, roster.id, today, Date.now());

  const beforeAlerts = await absenceFormAlertsForDay('monday', today);
  assert.ok(!beforeAlerts.some((a) => a.memberId === memberId), 'should not show up as an alert yet - still just checked in present');

  const res = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({
      type: 'absence',
      parentId: String(memberId),
      studentIds: String(memberId),
      sessionDate: today,
      reasonCategory: 'medical',
      reason: 'sent home sick after check-in',
    });
  assert.equal(res.status, 200);

  const afterAlerts = await absenceFormAlertsForDay('monday', today);
  assert.ok(afterAlerts.some((a) => a.memberId === memberId && a.status === 'absent'), 'should now show up on the Attendance page Alerts box / dashboard Alert Log');

  const { absences } = await absenceFormSubmissionsForRoster(roster.id, today);
  assert.ok(absences.some((a) => a.memberName === 'Already Checked In Alert Parent'), 'should also show up in the per-roster Alerts box data');
});

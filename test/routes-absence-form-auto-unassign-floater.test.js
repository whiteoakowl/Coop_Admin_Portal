// Real HTTP-level coverage for a real request: "if someone submits an
// absence form and they are currently assigned as a floater, it should
// automatically unassign them." routes/absence.js's own /absence/submit
// handler now calls utils/substitutes.js's unassignMemberForDate right
// after actually recording a member absent/late for a date, clearing any
// substitute_assignments row they hold on that same date - same "compute
// once, act on read" trigger point classSchedule.js's own
// absenceFormAbsentMemberIdsForDate comment describes ("a 'late'
// submission means they still won't be at their usual spot on time, so
// the automated sub system shouldn't count on them for a floater slot
// that day either"), just now an active DELETE instead of a passive
// exclusion from suggestions.
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

test('a member already checked in as present is NOT unassigned by a later, no-op absence submission', async () => {
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

  const res = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({
      type: 'absence',
      parentId: String(memberId),
      studentIds: String(memberId),
      sessionDate: today,
      reasonCategory: 'personal',
      reason: 'mistaken submission',
    });
  assert.equal(res.status, 200);

  const attendance = await db.prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, roster.id, today);
  assert.equal(attendance.status, 'present', 'an already-present status must be left unchanged (existing behavior)');

  const row = await db.prepare('SELECT member_id FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(today, 'job', jobId);
  assert.equal(row.member_id, memberId, 'the floater assignment should NOT be cleared when no real absence was recorded');
});

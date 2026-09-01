// Real bug report: "when a member clicks on the floater assignment
// button on the kiosk page it only show[s] permanent positions with
// floater assignments. it's not showing the floater assignments for
// classes that have a missing teacher or assistant. it did allow me to
// assign floaters to missing teacher positions but it isn't showing up
// on member kiosk view." GET /volunteers/:day (routes/volunteers.js) used
// to be built entirely from permanent_jobs - a class's own missing-
// teacher/assistant coverage (assigned from the admin Substitutes Needed
// board, substitute_assignments.slot_type='class') never appeared there
// at all. Covers utils/substitutes.js's publicFloaterCardsForDate: an
// approved class-coverage assignment now shows on the kiosk chart, a
// still-pending one doesn't (same "only a confirmed position" rule the
// existing permanent-job coverage already had - see test/routes-
// volunteers-public.test.js), and it never writes a new suggested
// assignment into the database just from being viewed (unlike
// substituteBoard, the admin board's own auto-picking function).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-public-class-coverage-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-public-class-coverage-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, addStaff } = require('../utils/classSchedule');
const { classStaffSlotId, setAssignment } = require('../utils/substitutes');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function makeMember(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

test('an approved floater covering a class\'s missing teacher shows up on the public kiosk chart', async () => {
  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const date = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, date);

  const teacherId = await makeMember('Class Coverage Teacher', 'class-coverage-teacher-1');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Needs A Sub Class', room: 'Room 7' });
  await addStaff(classId, teacherId, 'teacher');

  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Coverage Test Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(teacherId, rosterId, date);

  const floaterId = await makeMember('Class Coverage Floater', 'class-coverage-floater-1');
  await setAssignment(date, 'class', classStaffSlotId(classId, teacherId), floaterId, false); // writes status 'approved'

  const res = await request(app).get('/volunteers/monday');
  assert.equal(res.status, 200);
  assert.match(res.text, /Needs A Sub Class/, 'the class itself should appear as a position on the chart');
  const rowMatch = res.text.match(/Needs A Sub Class[\s\S]*?<\/tr>/);
  assert.ok(rowMatch, 'expected a table row for the class');
  assert.match(rowMatch[0], /Class Coverage Floater/, 'the approved floater\'s name should show, same as an approved permanent job would');
});

test('a still-pending (not yet approved) class-coverage pick is invisible on the public kiosk, not shown as "Unassigned"', async () => {
  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  // Closer than the previous test's own date - closestUpcomingDate always
  // resolves to the EARLIEST upcoming date across every volunteer_dates
  // row for this list (shared across every test in this file, since they
  // all run against the same database), so each later test needs a date
  // strictly closer than any before it, or the route would still show an
  // earlier test's own chart instead (see test/routes-volunteers-public.
  // test.js's own dates for the same pattern).
  const date = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, date);

  const teacherId = await makeMember('Pending Coverage Teacher', 'pending-coverage-teacher-1');
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Pending Sub Class' });
  await addStaff(classId, teacherId, 'teacher');

  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Pending Coverage Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(teacherId, rosterId, date);

  const floaterId = await makeMember('Pending Coverage Floater', 'pending-coverage-floater-1');
  await db
    .prepare(
      `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status) VALUES (?, 'class', ?, ?, 0, 'pending')`
    )
    .run(date, classStaffSlotId(classId, teacherId), floaterId);

  const res = await request(app).get('/volunteers/monday');
  assert.equal(res.status, 200);
  // A real request: "do not show positions that don't have someone
  // assigned. if it is unassigned it's invisible to members. only admins
  // can see it" - an open/still-pending position must not appear on the
  // public kiosk at all, not even as "Unassigned".
  assert.doesNotMatch(res.text, /Pending Sub Class/, 'an unassigned/still-pending position must be invisible on the public kiosk');
  assert.doesNotMatch(res.text, /Pending Coverage Floater/, 'a still-pending pick must not show its name on the public kiosk either');
});

test('viewing the public kiosk chart never itself writes a new suggested assignment into the database', async () => {
  const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
  const date = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, date);

  const teacherId = await makeMember('No Auto Pick Teacher', 'no-auto-pick-teacher-1');
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'No Auto Pick Class' });
  await addStaff(classId, teacherId, 'teacher');

  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('No Auto Pick Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(teacherId, rosterId, date);
  // A real floater on the day's list, so an auto-pick (if this route
  // wrongly triggered one, the way the admin Substitutes board's own
  // substituteBoard deliberately does) would have a real candidate to
  // actually pick.
  await makeMember('Available Floater Nobody Should Auto-Assign', 'available-floater-1');

  const before = await db.prepare('SELECT COUNT(*) AS c FROM substitute_assignments').get();
  const res = await request(app).get('/volunteers/monday');
  assert.equal(res.status, 200);
  const after = await db.prepare('SELECT COUNT(*) AS c FROM substitute_assignments').get();
  assert.equal(Number(after.c), Number(before.c), 'a plain page view must not write any new substitute_assignments row');
});

// Real bug report: "absence alerts on the attendance page should only
// show parents names that are absent." A student's own absence doesn't
// affect staffing/floater coverage the way a parent's does, so listing
// them was just noise on both alert surfaces this app has: the
// Attendance page's own inline Alerts box (routes/admin-rosters.js's
// absenceFormSubmissionsForRoster) and the sitewide alert popup/Home
// dashboard Alert Log (this file's own absenceFormAlertsForDay, which
// both read). This file covers the latter directly, since it's the one
// exported and date-parameterized (not gated on "today" actually being
// a session day the way the Attendance page's own box is) - the fix
// itself is the identical one-line member_type='parent' filter in both
// places.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `utils-alerts-absence-parent-only-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `utils-alerts-absence-parent-only-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const app = require('../server');
const db = require('../db');
const { absenceFormAlertsForDay } = require('../utils/alerts');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('absenceFormAlertsForDay only includes parents, not students, marked absent/late', async () => {
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Alert Test Parent', 'Alert Test Parent', 'parent')")
    .run();
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Alert Test Student', 'Alert Test Student', 'student')")
    .run();

  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-09-07', 'absent', 'absence_form')")
    .run(parentId, roster.id);
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-09-07', 'absent', 'absence_form')")
    .run(studentId, roster.id);

  const alerts = await absenceFormAlertsForDay('monday', '2026-09-07');
  const names = alerts.map((a) => a.memberName);
  assert.ok(names.includes('Alert Test Parent'), 'the absent parent should be included');
  assert.ok(!names.includes('Alert Test Student'), 'the absent student should NOT be included');
});

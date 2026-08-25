// A real user request: "the substitutes needed list under logs should
// only show teacher and assistant positions that need a floater, not
// permanent positions." utils/substitutes.js's substituteBoard() mixes
// both slotType:'class' (a missing teacher/assistant) and slotType:'job'
// (a permanent job, staffed every session regardless of who's absent) in
// its own slots array - that's still correct for admin-volunteers.js's
// Floater Assignments manage page, which deliberately shows both (see
// its own history), but the Logs "Substitutes Needed" list
// (routes/admin-logs.js's tab==='substitutes') should only ever show the
// former. Covers routes/admin-logs.js's own filter, scoped to just that
// route/tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-logs-substitutes-floater-only-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-logs-substitutes-floater-only-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, addStaff } = require('../utils/classSchedule');
const { createPermanentJob } = require('../utils/substitutes');

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

test('Logs: Substitutes Needed only shows the missing-teacher/assistant slot, not the permanent job in the same hour', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const date = '2026-03-02';

  const teacherId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Floater Only Teacher', 'floater-only-teacher', 'parent')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day, hourPosition: 1, className: 'Floater Only Class' });
  await addStaff(classId, teacherId, 'teacher');

  const rosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Floater Only Roster', 'Class Schedule')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'kiosk')")
    .run(teacherId, rosterId, date);

  await createPermanentJob({ day, hourPosition: 1, title: 'Floater Only Permanent Job', room: 'Room 9' });

  const res = await request(app).get(`/admin/logs?tab=substitutes&day=${day}&date=${date}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Floater Only Class/, 'the class missing its teacher should still show');
  assert.match(res.text, /Teacher absent: Floater Only Teacher/);
  assert.doesNotMatch(res.text, /Floater Only Permanent Job/, 'a permanent job in the same hour must not show on this list');
  assert.doesNotMatch(res.text, /Staffed every session/, 'the permanent-job-only reason text must not appear');
});

test('Logs: Substitutes Needed shows the empty state when only a permanent job needs coverage (no missing teacher/assistant)', async () => {
  const cookie = await loginAsAdmin();
  const day = 'wednesday';
  const date = '2026-03-04';

  await createPermanentJob({ day, hourPosition: 2, title: 'Floater Only Empty State Job', room: 'Room 3' });

  const res = await request(app).get(`/admin/logs?tab=substitutes&day=${day}&date=${date}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Floater Only Empty State Job/);
});

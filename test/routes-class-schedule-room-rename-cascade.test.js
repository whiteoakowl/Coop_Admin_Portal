// Regression coverage for a bug report: renaming a room via the Class
// Schedule grid's Edit Hours/Rooms dialog (POST /admin/class-schedule/:day/
// edit) updated the live grid (which reads classes.room directly) but left
// Schedule Cards (utils/schedule.js's getMemberSchedule, sourced from the
// derived member_schedules table) showing the OLD room name - because the
// route called syncMemberSchedulesForDay(day) BEFORE looping over the room
// renames, so the sync cached the still-stale room. Fixed by running the
// sync last, after every room rename has already been applied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-room-rename-cascade-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-room-rename-cascade-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');
const { getMemberSchedule } = require('../utils/schedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('renaming a room via the Edit Hours/Rooms dialog updates the cached Schedule Card room, not just the live grid', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Room Rename Cascade Kid', 'room-rename-cascade-kid', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Room Rename Cascade Class', room: 'Old Room Name', startTime: '9:00 AM', endTime: '9:45 AM' });
  await setEnrollment(classId, [studentId]);

  const before = await getMemberSchedule(studentId);
  assert.equal(before.monday.find((r) => r.class_number === 1).room, 'Old Room Name', 'sanity check: the schedule card starts with the pre-rename room');

  const res = await request(app)
    .post('/admin/class-schedule/monday/edit')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .type('form')
    .send({
      labels: ['', '', '', ''],
      oldNames: ['Old Room Name'],
      newNames: ['New Room Name'],
    });
  assert.equal(res.status, 302);

  const cls = await db.prepare('SELECT room FROM classes WHERE id = ?').get(classId);
  assert.equal(cls.room, 'New Room Name', 'sanity check: the live grid picked up the rename');

  const after = await getMemberSchedule(studentId);
  assert.equal(after.monday.find((r) => r.class_number === 1).room, 'New Room Name', 'the Schedule Card should reflect the renamed room, not the stale cached one');
});

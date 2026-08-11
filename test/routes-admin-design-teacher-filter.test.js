// Coverage for the Design/Print hub's "Teachers Only" print-picker filter
// (utils/members.js's membersWithDetails/isTeacher, wired into
// views/partials/print-picker-table.ejs's data-teacher attribute and
// public/js/design-print-hub.js's filter logic). The filter itself is
// client-side JS a jsdom-free route test can't exercise directly (same
// reasoning as test/routes-name-tag-barcode-print.test.js) - this locks
// in the markup contract it depends on: a member who teaches a class gets
// data-teacher="1", everyone else gets "0", and the dropdown offers the
// option at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-design-teacher-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-design-teacher-filter-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('Design/Print hub print tab marks teachers with data-teacher, and offers a Teachers Only filter option', async () => {
  const { lastInsertRowid: teacherId } = db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Teacher', 'Pat Teacher', 'parent')")
    .run();
  db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Sam Parent', 'Sam Parent', 'parent')").run();
  const { lastInsertRowid: classId } = db
    .prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Art')")
    .run();
  db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherId);

  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];

  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const teacherRow = new RegExp(`data-type="parent" data-teacher="1"[^>]*data-name="pat teacher"`);
  const parentRow = new RegExp(`data-type="parent" data-teacher="0"[^>]*data-name="sam parent"`);
  assert.match(res.text, teacherRow, 'the teacher gets data-teacher="1"');
  assert.match(res.text, parentRow, 'a non-teaching parent gets data-teacher="0"');
  assert.match(res.text, /<option value="teacher">Teachers Only<\/option>/);
});

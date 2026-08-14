// Real HTTP-level coverage for a single class's own "Import Students"
// roster import (routes/admin-class-schedule.js's GET
// /class-schedule/classes/:id/roster/import-template.xlsx + POST
// .../roster/import) after its single Student Name column was split into
// separate Student First/Last Name columns, joined back into the single
// "First Last" string every member is stored as before matching against
// active students.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-roster-import-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-roster-import-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const XLSX = require('xlsx');

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

test('GET .../roster/import-template.xlsx has separate Student First/Last Name columns', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const classBuffer = (() => {
    const ws = XLSX.utils.aoa_to_sheet([['Day', 'Hour', 'Class Name', 'Room', 'Age Group'], ['Monday', '1', 'Roster Import Class', 'Room 1', 'All Ages']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Import');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();
  await request(app)
    .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', classBuffer, 'classes.xlsx');
  const cls = await db.prepare("SELECT id FROM classes WHERE class_name = 'Roster Import Class'").get();
  assert.ok(cls, 'setup: the class should exist');

  const res = await request(app)
    .get(`/admin/class-schedule/classes/${cls.id}/roster/import-template.xlsx`)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  const wb = XLSX.read(res.body, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  assert.deepEqual(rows[0], ['Student First Name', 'Student Last Name']);

  await t_addStudentAndImport(cookie, csrfToken, cls.id);
});

async function t_addStudentAndImport(cookie, csrfToken, classId) {
  await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Roster Import Kid', memberType: 'student', _csrf: csrfToken });

  const ws = XLSX.utils.aoa_to_sheet([['Student First Name', 'Student Last Name'], ['Roster Import', 'Kid']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/roster/import?_csrf=` + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', buffer, 'roster.xlsx');
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(res.headers.location).includes('Added 1 student(s)'));

  const student = await db.prepare("SELECT id FROM members WHERE name = 'Roster Import Kid'").get();
  assert.ok(student, 'Student First/Last Name columns should have joined into the stored name');
  const enrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(classId, student.id);
  assert.ok(enrolled, 'the matched student should be enrolled in the class');
}

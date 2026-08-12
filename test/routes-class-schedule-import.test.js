// Real HTTP-level coverage for a feature this session: the "Import
// Classes" spreadsheet import (routes/admin-class-schedule.js's own
// /class-schedule/import-template.xlsx + /class-schedule/:day/import) now
// also accepts a Teacher and up to 3 Assistants column, matched against
// active parents by exact (case-insensitive) name and staffed onto the
// newly created class - previously this import only ever created the bare
// class shell (day/hour/name/room/age group) with no one assigned to it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-import-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-import-test-uploads-${process.pid}`);
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

const IMPORT_HEADERS = ['Day', 'Hour', 'Class Name', 'Room', 'Age Group', 'Teacher', 'Assistant 1', 'Assistant 2', 'Assistant 3'];

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('GET /admin/class-schedule/import-template.xlsx includes Teacher + 3 Assistant columns', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app)
    .get('/admin/class-schedule/import-template.xlsx')
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
  assert.deepEqual(rows[0], IMPORT_HEADERS);
});

test('POST /admin/class-schedule/monday/import', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  // Two active parents to be matched as staff by name.
  await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Jane Teacher', memberType: 'parent', _csrf: csrfToken });
  await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Alex Assistant', memberType: 'parent', _csrf: csrfToken });

  await t.test('a row with Teacher + Assistant columns staffs the new class accordingly', async () => {
    const buffer = buildImportBuffer([['Monday', '1', 'Art Adventures', 'Room 3', 'Ages 5-7', 'Jane Teacher', 'Alex Assistant', '', '']]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'classes.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const cls = await db.prepare("SELECT id FROM classes WHERE class_name = 'Art Adventures'").get();
    assert.ok(cls, 'the class should have been created');

    const staff = await db
      .prepare('SELECT m.name, cs.role FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = ?')
      .all(cls.id);
    const teacher = staff.find((s) => s.role === 'teacher');
    const assistants = staff.filter((s) => s.role === 'assistant');
    assert.equal(teacher && teacher.name, 'Jane Teacher');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].name, 'Alex Assistant');
  });

  await t.test('all 3 assistant columns can be used at once', async () => {
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Assistant Two', memberType: 'parent', _csrf: csrfToken });
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Assistant Three', memberType: 'parent', _csrf: csrfToken });
    const buffer = buildImportBuffer([['Monday', '2', 'Science Lab', 'Room 8', 'Ages 8-10', '', 'Alex Assistant', 'Assistant Two', 'Assistant Three']]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'classes-3-assist.xlsx');
    assert.equal(res.status, 302);

    const cls = await db.prepare("SELECT id FROM classes WHERE class_name = 'Science Lab'").get();
    const assistantNames = (await db
      .prepare("SELECT m.name FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = ? AND cs.role = 'assistant'")
      .all(cls.id))
      .map((r) => r.name)
      .sort();
    assert.deepEqual(assistantNames, ['Alex Assistant', 'Assistant Three', 'Assistant Two']);
  });

  await t.test('a Teacher/Assistant name that matches no active parent is skipped, not fatal to the row', async () => {
    const buffer = buildImportBuffer([['Wednesday', '1', 'PE', 'Gym', 'All Ages', 'Nobody Real', '', '', '']]);
    const res = await request(app)
      .post('/admin/class-schedule/wednesday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'classes-unknown-staff.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('not found'), 'the notice should mention the unmatched teacher/assistant name');

    const cls = await db.prepare("SELECT id FROM classes WHERE class_name = 'PE'").get();
    assert.ok(cls, 'the class itself should still be created even though the teacher name did not match anyone');
    const staffCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM class_staff WHERE class_id = ?').get(cls.id)).c);
    assert.equal(staffCount, 0);
  });
});

// Real HTTP-level coverage for the "Import Classes" spreadsheet import
// (routes/admin-class-schedule.js's own /class-schedule/import-template.xlsx
// + /class-schedule/:day/import): Teacher, a 2nd Teacher, and up to 3
// Assistants are each a single Name column (matched against active parents
// by exact case-insensitive name and staffed onto the newly created class -
// class_staff allows any number of 'teacher'-role rows per class, so a 2nd
// Teacher is staffed exactly the same way as the first), the old "Age
// Group" column is now labeled "Grade", and Class Start Time, Class End
// Time, and Class Description columns land straight on the new class's own
// start_time/end_time/notes columns.
//
// A real bug report: a real registration export's Day column used "Mon"/
// "Wed" (not the full word) and had no "Hour" concept at all - its Hour
// column ended up holding an actual clock time instead of a 1-4 slot
// number - so every single row got silently skipped. Day now tolerates
// the abbreviation (utils/days.js's parseDayValue), and Hour is optional:
// when it's missing or not a valid 1-4 position, the row's Start Time is
// used to auto-assign one instead (see buildAutoHourPositions).
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

const IMPORT_HEADERS = [
  'Day', 'Hour', 'Class Name', 'Room', 'Grade',
  'Class Start Time', 'Class End Time', 'Class Description',
  'Teacher', '2nd Teacher', 'Assistant 1', 'Assistant 2', 'Assistant 3',
];

function buildImportBuffer(rows) {
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('GET /admin/class-schedule/import-template.xlsx has Grade (not Age Group), Start/End Time, Description, Teacher, 2nd Teacher, and 3 Assistant columns', async () => {
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
    const buffer = buildImportBuffer([['Monday', '1', 'Art Adventures', 'Room 3', '1st', '', '', '', 'Jane Teacher', '', 'Alex Assistant', '', '']]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'classes.xlsx');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /notice=/);

    const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Art Adventures'").get();
    assert.ok(cls, 'the class should have been created');
    assert.equal(cls.age_group, '1st', 'the Grade column still lands on the class\'s own age_group field');

    const staff = await db
      .prepare('SELECT m.name, cs.role FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = ?')
      .all(cls.id);
    const teacher = staff.find((s) => s.role === 'teacher');
    const assistants = staff.filter((s) => s.role === 'assistant');
    assert.equal(teacher && teacher.name, 'Jane Teacher');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].name, 'Alex Assistant');
  });

  await t.test('Class Start/End Time and Description land on the class row, and a 2nd Teacher is staffed alongside the first', async () => {
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Pat Second', memberType: 'parent', _csrf: csrfToken });
    const buffer = buildImportBuffer([
      ['Monday', '3', 'Music Time', 'Room 5', '2nd', '9:00 AM', '9:45 AM', 'Singing and instruments', 'Jane Teacher', 'Pat Second', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'classes-time-desc.xlsx');
    assert.equal(res.status, 302);

    const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Music Time'").get();
    assert.ok(cls, 'the class should have been created');
    assert.equal(cls.start_time, '9:00 AM');
    assert.equal(cls.end_time, '9:45 AM');
    assert.equal(cls.notes, 'Singing and instruments');

    const teachers = (await db
      .prepare("SELECT m.name FROM class_staff cs JOIN members m ON m.id = cs.member_id WHERE cs.class_id = ? AND cs.role = 'teacher'")
      .all(cls.id))
      .map((r) => r.name)
      .sort();
    assert.deepEqual(teachers, ['Jane Teacher', 'Pat Second']);
  });

  await t.test('all 3 assistant columns can be used at once', async () => {
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Assistant Two', memberType: 'parent', _csrf: csrfToken });
    await request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send({ name: 'Assistant Three', memberType: 'parent', _csrf: csrfToken });
    const buffer = buildImportBuffer([
      ['Monday', '2', 'Science Lab', 'Room 8', '', '', '', '', '', '', 'Alex Assistant', 'Assistant Two', 'Assistant Three'],
    ]);
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
    const buffer = buildImportBuffer([['Wednesday', '1', 'PE', 'Gym', '', '', '', '', 'Nobody Real', '', '', '', '']]);
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

  await t.test('a real-world file - Day abbreviated "Mon"/"Wed" and Hour column holding an actual clock time instead of 1-4 - is not skipped', async () => {
    const buffer = buildImportBuffer([
      ['Mon', '10:45 AM', 'Anatomy', 'House 2', '7th,8th', '', '', '', '', '', '', '', ''],
      ['Wed', '10:00 AM', 'Biology', 'House 3', '9th', '', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'real-world.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 class'), 'both rows should import, not get silently skipped');

    const anatomy = await db.prepare("SELECT * FROM classes WHERE class_name = 'Anatomy'").get();
    assert.ok(anatomy);
    assert.equal(anatomy.day, 'monday', '"Mon" should resolve to monday');
    assert.equal(anatomy.age_group, '7th,8th');

    const biology = await db.prepare("SELECT * FROM classes WHERE class_name = 'Biology'").get();
    assert.ok(biology);
    assert.equal(biology.day, 'wednesday', '"Wed" should resolve to wednesday');
  });

  await t.test('rows sharing a day but no valid Hour get distinct auto-assigned slots, sorted by their own Start Time', async () => {
    const buffer = buildImportBuffer([
      ['Mon', '', 'Later Class', 'Room 1', '', '11:00 AM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Earlier Class', 'Room 2', '', '9:00 AM', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'auto-slots.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 class'));

    const earlier = await db.prepare("SELECT hour_position FROM classes WHERE class_name = 'Earlier Class'").get();
    const later = await db.prepare("SELECT hour_position FROM classes WHERE class_name = 'Later Class'").get();
    assert.ok(earlier.hour_position < later.hour_position, 'the earlier Start Time should land in the lower-numbered slot regardless of row order in the file');
  });

  await t.test('a 5th distinct Start Time in the same day has no slot left and is skipped, not fatal to the others', async () => {
    const buffer = buildImportBuffer([
      ['Mon', '', 'Overflow A', 'Room 1', '', '8:00 AM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Overflow B', 'Room 1', '', '9:00 AM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Overflow C', 'Room 1', '', '10:00 AM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Overflow D', 'Room 1', '', '11:00 AM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Overflow E', 'Room 1', '', '12:00 PM', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'overflow.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 4 class'), 'only 4 slots exist per day');
    assert.ok(decodeURIComponent(res.headers.location).includes('1 row(s) skipped'));
    assert.equal(await db.prepare("SELECT id FROM classes WHERE class_name = 'Overflow E'").get(), undefined);
  });
});

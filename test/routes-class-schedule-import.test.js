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

// /admin/members/new-single (a flat {name, memberType} fixture route) was
// removed - "there shouldn't be any lone admins/leaders, or single
// members" - so this fixture now goes through the real family-intake
// form (/admin/members/new) instead, with a throwaway filler entry on
// the side it doesn't care about (createParentMember/createChildMember
// never enforce name uniqueness, so a constant filler name is safe to
// reuse across calls).
async function addSingleMember(cookie, csrfToken, name, memberType) {
  const body = { newFamilyName: `${name} Family`, _csrf: csrfToken };
  if (memberType === 'parent') {
    body['parents[0][name]'] = name;
    body['children[0][name]'] = 'Filler Child';
  } else {
    body['parents[0][name]'] = 'Filler Parent';
    body['children[0][name]'] = name;
  }
  return request(app).post('/admin/members/new').set('Cookie', cookie).type('form').send(body);
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
  await addSingleMember(cookie, csrfToken, 'Jane Teacher', 'parent');
  await addSingleMember(cookie, csrfToken, 'Alex Assistant', 'parent');

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

  // Staffing during import batches the expensive day-level roster/schedule
  // rebuild (addStaff's skipSync option - see its own comment in
  // utils/classSchedule.js) into one call after the whole file instead of
  // one per staff member added, since a real import can staff dozens of
  // rows and that rebuild was slow enough over a real network connection
  // to Supabase to make a large file time out. This proves that rebuild
  // still actually runs and produces the correct end state, not just that
  // class_staff itself got the right row.
  await t.test('the batched day-roster sync after import still reflects a newly staffed teacher (member_schedules + the day\'s auto Parent roster)', async () => {
    const buffer = buildImportBuffer([['Monday', '4', 'Pottery', 'Room 9', '', '9:00 AM', '9:45 AM', '', 'Jane Teacher', '', '', '', '']]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'pottery.xlsx');
    assert.equal(res.status, 302);

    const teacher = await db.prepare("SELECT id FROM members WHERE name = 'Jane Teacher'").get();
    const scheduleRow = await db.prepare('SELECT * FROM member_schedules WHERE member_id = ? AND day = ? AND class_name = ?').get(teacher.id, 'monday', 'Pottery');
    assert.ok(scheduleRow, 'member_schedules should reflect the newly staffed teacher on this class, not just class_staff');

    const rosterIdSetting = await db.prepare("SELECT value FROM app_settings WHERE key = 'monday_parent_roster_id'").get();
    assert.ok(rosterIdSetting, "Monday's auto Parent roster should exist");
    const onRoster = await db
      .prepare("SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ? AND source = 'auto'")
      .get(rosterIdSetting.value, teacher.id);
    assert.ok(onRoster, 'the newly staffed teacher should be on Monday\'s auto Parent roster after import');
  });

  await t.test('Class Start/End Time and Description land on the class row, and a 2nd Teacher is staffed alongside the first', async () => {
    await addSingleMember(cookie, csrfToken, 'Pat Second', 'parent');
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
    await addSingleMember(cookie, csrfToken, 'Assistant Two', 'parent');
    await addSingleMember(cookie, csrfToken, 'Assistant Three', 'parent');
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

  await t.test('the same class name/room across two adjacent auto-assigned hour blocks gets a matching color, so the room grid merges them into one spanned cell', async () => {
    const { roomGridForDay } = require('../utils/classSchedule');
    const buffer = buildImportBuffer([
      ['Mon', '', 'Long Class', 'Span Room', '', '1:00 PM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Long Class', 'Span Room', '', '1:45 PM', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'span-color.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 class'));

    const rows = await db.prepare("SELECT color, hour_position FROM classes WHERE class_name = 'Long Class' ORDER BY hour_position").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].color, rows[1].color, 'both hour blocks of the same class should share a color');
    assert.equal(rows[1].hour_position, rows[0].hour_position + 1, 'should land in adjacent hour slots');

    const grid = await roomGridForDay('monday');
    const spanRow = grid.rows.find((r) => r.room === 'Span Room');
    assert.ok(spanRow, 'expected a Span Room row in the grid');
    const spannedCell = spanRow.cells.find((c) => c.span === 2 && c.classes[0].class_name === 'Long Class');
    assert.ok(spannedCell, 'the two hour blocks should have merged into one colspan="2" cell instead of two separate cells');
  });

  // A real bug report: a recurring class name split across grade bands
  // (e.g. the same club name offered separately to two different grade
  // groups, same room, adjacent time slots) was getting merged into one
  // spanned cell by the fix above - correct for one class continuing
  // across two hours, wrong here since these are two unrelated classes
  // that only coincidentally share a name. Merging silently dropped the
  // second one's own grade/teacher/roster from the grid entirely, which
  // read as that row having been ignored by the import even though it
  // was actually created.
  await t.test('the same class name/room but a DIFFERENT grade across two adjacent hour blocks is NOT merged - both stay visible with their own info', async () => {
    const { roomGridForDay } = require('../utils/classSchedule');
    const buffer = buildImportBuffer([
      ['Mon', '', 'Forest Wildlings', 'Nature Room', 'K-2', '2:00 PM', '', '', '', '', '', '', ''],
      ['Mon', '', 'Forest Wildlings', 'Nature Room', '3-5', '2:45 PM', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'different-grade.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 class'), 'both rows should be created, not treated as a duplicate');

    const rows = await db.prepare("SELECT color, age_group, hour_position FROM classes WHERE class_name = 'Forest Wildlings' ORDER BY hour_position").all();
    assert.equal(rows.length, 2, 'both grade-band rows should exist as separate classes');
    assert.notEqual(rows[0].color, rows[1].color, 'different grades should not be forced to share a color, since they are not the same continuing class');

    const grid = await roomGridForDay('monday');
    const natureRow = grid.rows.find((r) => r.room === 'Nature Room');
    assert.ok(natureRow, 'expected a Nature Room row in the grid');
    const mergedCell = natureRow.cells.find((c) => c.span === 2 && c.classes[0].class_name === 'Forest Wildlings');
    assert.equal(mergedCell, undefined, 'different-grade classes must not be merged into one spanned cell');
    const gradeLabels = natureRow.cells
      .filter((c) => c.classes.some((cls) => cls.class_name === 'Forest Wildlings'))
      .flatMap((c) => c.classes)
      .map((cls) => cls.age_group)
      .sort();
    assert.deepEqual(gradeLabels, ['3-5', 'K-2'], 'both grade bands should still be visible on the grid, not one hidden by the merge');
  });

  // A real bug report: "on the wednesday class schedule page times in the
  // top row don't match where the classes should be", later found to have
  // an even worse second half: the header could get permanently STUCK
  // showing a wrong time - an earlier fix here wrote a computed label into
  // the stored class_schedule_hours row at import time, and that write
  // never got undone once its triggering class was later deleted or
  // fixed, leaving the header wrong even after the bad data was gone.
  // Fixed by never writing anything at import time and instead deriving
  // the header live from whatever classes actually exist right now (see
  // roomGridForDay in utils/classSchedule.js) - this just proves import
  // itself no longer touches the stored label at all, so it can't get
  // stuck; the live-derivation behavior itself is covered in
  // test/routes-class-schedule-room-grid.test.js.
  await t.test('importing rows with auto-derived hour positions does not write anything into the stored, hand-editable hour labels', async () => {
    const { hoursForDay } = require('../utils/classSchedule');
    const before = await hoursForDay('wednesday');

    const buffer = buildImportBuffer([
      ['Wed', '', 'Label Check A', 'Room 1', '', '9:15 AM', '', '', '', '', '', '', ''],
      ['Wed', '', 'Label Check B', 'Room 2', '', '11:30 AM', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app)
      .post('/admin/class-schedule/wednesday/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .attach('file', buffer, 'label-check.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Imported 2 class'));

    const after = await hoursForDay('wednesday');
    assert.deepEqual(after.map((h) => h.label), before.map((h) => h.label), 'the stored hour labels (what "Edit Hours" shows/edits) should be untouched by import');
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

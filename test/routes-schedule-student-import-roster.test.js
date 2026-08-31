// Real HTTP-level coverage for the Member Schedules Import
// (routes/admin-schedule.js's GET /schedule/members/import-template.xlsx +
// POST /schedule/members/import, memberType=student|parent): one row = one
// whole member's week, with up
// to 8 numbered class slots (Class Start Time N / Class Title N / Class
// Location N / Class Days N), each slot carrying its own Day value rather
// than the day being implied by slot position - this shape mirrors a real
// external registration-system export directly, so that kind of file can
// be uploaded with no reformatting. Plus an optional Allergy column.
// Locks in existing (and easy to accidentally regress) enrollment
// behavior too: importing a Student Schedule row doesn't just record the
// enrollment - it has to actually land the student on that specific
// class's roster (roster_members, via utils/classSchedule.js's
// setEnrollment -> syncClassRosterMembers) AND on the day's own Student
// roster the main dashboard/attendance page reads from
// (syncDayMemberRosters), or "import a schedule" wouldn't actually get
// anyone checked in on class day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-import-roster-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-import-roster-test-uploads-${process.pid}`);
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

function buildImportBuffer(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const SLOT_COUNT = 8;
const SCHEDULE_HEADERS = ['Member First Name', 'Member Last Name', 'Allergy'];
for (let i = 1; i <= SLOT_COUNT; i++) {
  SCHEDULE_HEADERS.push(`Class Start Time ${i}`, `Class Title ${i}`, `Class Location ${i}`, `Class Days ${i}`);
}

// slots: array of { position, startTime, className, room, days } - every
// other one of the up to 8 numbered slot columns is left blank.
function buildScheduleRow({ firstName, lastName, allergy = '', slots = [] }) {
  const row = [firstName, lastName, allergy];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const slot = slots.find((s) => s.position === i);
    row.push(slot ? slot.startTime : '', slot ? slot.className : '', slot ? slot.room : '', slot ? slot.days : '');
  }
  return row;
}

test('GET /admin/schedule/members/import-template.xlsx has Member First/Last Name, Allergy, and 8 numbered Class Start Time/Title/Location/Days slots', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app)
    .get('/admin/schedule/members/import-template.xlsx')
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
  assert.deepEqual(rows[0], SCHEDULE_HEADERS);
});

test('POST /admin/schedule/members/import', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const classBuffer = buildImportBuffer(
    ['Day', 'Hour', 'Class Name', 'Room', 'Grade'],
    [
      ['Monday', '1', 'Import Roster Class', 'Room 1', ''],
      ['Wednesday', '2', 'Second Class', 'Room 2', ''],
    ]
  );
  await request(app)
    .post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken))
    .set('Cookie', cookie)
    .attach('file', classBuffer, 'classes.xlsx');
  const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Import Roster Class'").get();
  const cls2 = await db.prepare("SELECT * FROM classes WHERE class_name = 'Second Class'").get();
  assert.ok(cls && cls2, 'setup: both classes should exist before importing a schedule row for them');

  await t.test('a row with one filled slot (Class Days "Mon") puts the student on both the class roster and the day-level Student roster', async () => {
    await addSingleMember(cookie, csrfToken, 'Roster Test Kid', 'student');

    const scheduleBuffer = buildImportBuffer(SCHEDULE_HEADERS, [
      buildScheduleRow({ firstName: 'Roster Test', lastName: 'Kid', slots: [{ position: 1, startTime: '', className: 'Import Roster Class', room: '', days: 'Mon' }] }),
    ]);
    const res = await request(app)
      .post('/admin/schedule/members/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .field('memberType', 'student')
      .attach('file', scheduleBuffer, 'schedule.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Matched 1 schedule row'));

    const student = await db.prepare("SELECT id FROM members WHERE name = 'Roster Test Kid'").get();

    // On the class's own roster (Class Roster - what Class Check-In and
    // the class's attendance sheet read from).
    const onClassRoster = await db
      .prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?')
      .get(cls.roster_id, student.id);
    assert.ok(onClassRoster, 'the student should be on the class\'s own roster after import');

    // On Monday's day-level Student roster (what the main dashboard /
    // Attendance page reads from for "who's expected Monday").
    const mondayStudentRosterId = await db.prepare("SELECT value FROM app_settings WHERE key = 'monday_student_roster_id'").get();
    assert.ok(mondayStudentRosterId, 'setup: the day-level Monday Student roster should already exist');
    const onDayRoster = await db
      .prepare('SELECT 1 FROM roster_members WHERE roster_id = ? AND member_id = ?')
      .get(mondayStudentRosterId.value, student.id);
    assert.ok(onDayRoster, 'the student should also be on Monday\'s day-level Student roster after import, not just the class roster');
  });

  await t.test('a row with slots on both "Mon" and "Wed" enrolls the member in both classes in one pass, regardless of slot number', async () => {
    await addSingleMember(cookie, csrfToken, 'Two Day Kid', 'student');

    const scheduleBuffer = buildImportBuffer(SCHEDULE_HEADERS, [
      buildScheduleRow({
        firstName: 'Two Day',
        lastName: 'Kid',
        // Deliberately out of "day order" (Wednesday class in slot 1,
        // Monday class in slot 2) - a real export's slot numbers don't
        // correspond to which day a class falls on.
        slots: [
          { position: 1, startTime: '', className: 'Second Class', room: '', days: 'Wed' },
          { position: 2, startTime: '', className: 'Import Roster Class', room: '', days: 'Mon' },
        ],
      }),
    ]);
    const res = await request(app)
      .post('/admin/schedule/members/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .field('memberType', 'student')
      .attach('file', scheduleBuffer, 'schedule-two-day.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('Matched 2 schedule row'));

    const student = await db.prepare("SELECT id FROM members WHERE name = 'Two Day Kid'").get();
    const onFirst = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, student.id);
    const onSecond = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls2.id, student.id);
    assert.ok(onFirst, 'should be enrolled in the Monday class even though it was in slot 2');
    assert.ok(onSecond, 'should also be enrolled in the Wednesday class even though it was in slot 1');
  });

  await t.test('a Class Days value this app has no day for (e.g. "Thursday") is skipped, not fatal to the row', async () => {
    await addSingleMember(cookie, csrfToken, 'Thursday Kid', 'student');

    const scheduleBuffer = buildImportBuffer(SCHEDULE_HEADERS, [
      buildScheduleRow({ firstName: 'Thursday', lastName: 'Kid', slots: [{ position: 1, startTime: '', className: 'Import Roster Class', room: '', days: 'Thursday' }] }),
    ]);
    const res = await request(app)
      .post('/admin/schedule/members/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .field('memberType', 'student')
      .attach('file', scheduleBuffer, 'schedule-thursday.xlsx');
    assert.equal(res.status, 302);
    assert.ok(decodeURIComponent(res.headers.location).includes('1 skipped'), 'a day this app has no class model for should be skipped, not throw');

    const student = await db.prepare("SELECT id FROM members WHERE name = 'Thursday Kid'").get();
    const enrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, student.id);
    assert.equal(enrolled, undefined, 'should not have been enrolled anywhere');
  });

  await t.test('the Allergy column fills in a blank medical_notes but never overwrites an existing one', async () => {
    await db.prepare("INSERT INTO members (name, barcode, member_type, medical_notes) VALUES ('Existing Allergy Kid', 'existing-allergy-kid', 'student', 'Already has peanut allergy on file')").run();
    await addSingleMember(cookie, csrfToken, 'Blank Allergy Kid 2', 'student');

    const scheduleBuffer = buildImportBuffer(SCHEDULE_HEADERS, [
      buildScheduleRow({ firstName: 'Blank Allergy Kid', lastName: '2', allergy: 'Tree nut allergy', slots: [] }),
      buildScheduleRow({ firstName: 'Existing Allergy', lastName: 'Kid', allergy: 'Should not overwrite', slots: [] }),
    ]);
    const res = await request(app)
      .post('/admin/schedule/members/import?_csrf=' + encodeURIComponent(csrfToken))
      .set('Cookie', cookie)
      .field('memberType', 'student')
      .attach('file', scheduleBuffer, 'schedule-allergy.xlsx');
    assert.equal(res.status, 302);

    const blank = await db.prepare("SELECT medical_notes FROM members WHERE name = 'Blank Allergy Kid 2'").get();
    assert.equal(blank.medical_notes, 'Tree nut allergy');

    const existing = await db.prepare("SELECT medical_notes FROM members WHERE name = 'Existing Allergy Kid'").get();
    assert.equal(existing.medical_notes, 'Already has peanut allergy on file', 'an already-set medical_notes value must never be overwritten by the import');
  });
});

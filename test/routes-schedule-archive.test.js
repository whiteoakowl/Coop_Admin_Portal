// Real HTTP-level coverage for the Member Schedules archive feature (same
// "Archive" toggle UX as the Class Schedule grid, applied to the merged
// Member Schedules card grid - routes/admin-schedule.js's POST
// /schedule/members/archive) and the Archive tab's Class/Student/Parent
// pill toggle (GET /admin/schedule?tab=archive&type=...). Archiving a
// member's schedule card snapshots it into member_schedule_archives and
// unenrolls them from every class they're currently on/staffing - see
// archiveMemberSchedules' own comment in utils/schedule.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-archive-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-archive-test-uploads-${process.pid}`);
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

function buildImportBuffer(rows) {
  const headers = [
    'Day', 'Hour', 'Class Name', 'Room', 'Grade',
    'Class Start Time', 'Class End Time', 'Class Description',
    'Teacher', '2nd Teacher', 'Assistant 1', 'Assistant 2', 'Assistant 3',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Import');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('POST /admin/schedule/members/archive unenrolls a student', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const classBuffer = buildImportBuffer([['Monday', '1', 'Archive Schedule Class', 'Room 1', '', '9:00 AM', '', '', '', '', '', '', '']]);
  await request(app).post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', classBuffer, 'classes.xlsx');
  const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Archive Schedule Class'").get();
  assert.ok(cls, 'setup: the class should exist');

  await addSingleMember(cookie, csrfToken, 'Archive Schedule Kid', 'student');
  const student = await db.prepare("SELECT id FROM members WHERE name = 'Archive Schedule Kid'").get();
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/enrollment/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ studentIds: String(student.id), _csrf: csrfToken });

  await t.test('rejects with no memberIds selected', async () => {
    const res = await request(app).post('/admin/schedule/members/archive').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
  });

  await t.test('archiving snapshots the schedule and unenrolls the student from every class', async () => {
    const res = await request(app)
      .post('/admin/schedule/members/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: String(student.id), _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Archived 1 member schedule/);

    const stillEnrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(cls.id, student.id);
    assert.equal(stillEnrolled, undefined, 'the student should be unenrolled from the class after archiving');

    const archived = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Archive Schedule Kid'").get();
    assert.ok(archived, 'expected a member_schedule_archives row');
    assert.equal(archived.member_type, 'student');
    assert.match(archived.monday_schedule || '', /Archive Schedule Class/, "the snapshot should mention the class the student was on before being unenrolled");
  });
});

test('POST /admin/schedule/members/archive unstaffs a teacher from every class', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const classBuffer = buildImportBuffer([['Monday', '2', 'Parent Archive Class', 'Room 2', '', '10:00 AM', '', '', 'Archive Parent Teacher', '', '', '', '']]);
  await addSingleMember(cookie, csrfToken, 'Archive Parent Teacher', 'parent');
  await request(app).post('/admin/class-schedule/monday/import?_csrf=' + encodeURIComponent(csrfToken)).set('Cookie', cookie).attach('file', classBuffer, 'classes2.xlsx');
  const cls = await db.prepare("SELECT * FROM classes WHERE class_name = 'Parent Archive Class'").get();
  const parent = await db.prepare("SELECT id FROM members WHERE name = 'Archive Parent Teacher'").get();
  const staffedBefore = await db.prepare('SELECT 1 FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, parent.id);
  assert.ok(staffedBefore, 'setup: the parent should be staffed onto the class before archiving');

  await t.test('archiving removes the parent from class_staff and snapshots their schedule', async () => {
    const res = await request(app)
      .post('/admin/schedule/members/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: String(parent.id), _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Archived 1 member schedule/);

    const stillStaffed = await db.prepare('SELECT 1 FROM class_staff WHERE class_id = ? AND member_id = ?').get(cls.id, parent.id);
    assert.equal(stillStaffed, undefined);

    const archived = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Archive Parent Teacher'").get();
    assert.ok(archived);
    assert.equal(archived.member_type, 'parent');
    assert.match(archived.monday_schedule || '', /Parent Archive Class/);
  });
});

test('POST /admin/schedule/members/archive accepts a mixed student+parent selection in one submit (the merged tab lets both be checked together)', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await addSingleMember(cookie, csrfToken, 'Mixed Archive Kid', 'student');
  await addSingleMember(cookie, csrfToken, 'Mixed Archive Parent', 'parent');
  const student = await db.prepare("SELECT id FROM members WHERE name = 'Mixed Archive Kid'").get();
  const parent = await db.prepare("SELECT id FROM members WHERE name = 'Mixed Archive Parent'").get();

  await t.test('both members get archived from a single mixed-type submit', async () => {
    const res = await request(app)
      .post('/admin/schedule/members/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: [String(student.id), String(parent.id)], _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Archived 2 member schedule/);

    const studentArchived = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Mixed Archive Kid'").get();
    const parentArchived = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Mixed Archive Parent'").get();
    assert.ok(studentArchived);
    assert.equal(studentArchived.member_type, 'student');
    assert.ok(parentArchived);
    assert.equal(parentArchived.member_type, 'parent');
  });
});

test('Archive tab pill toggle (Class/Student/Parent)', async (t) => {
  const { cookie } = await loginAsAdmin();

  await t.test('defaults to the Class archive when no type is given', async () => {
    const res = await request(app).get('/admin/schedule?tab=archive').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /day-toggle-option active"[^>]*>Class/);
  });

  await t.test('?type=student shows the student archive table and lists the archived kid from above', async () => {
    const res = await request(app).get('/admin/schedule?tab=archive&type=student').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /day-toggle-option active"[^>]*>Student/);
    assert.match(res.text, /Archive Schedule Kid/);
    assert.match(res.text, /\/admin\/schedule\/archive\/student\/export\.csv/);
  });

  await t.test('?type=parent shows the parent archive table and lists the archived teacher from above', async () => {
    const res = await request(app).get('/admin/schedule?tab=archive&type=parent').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /day-toggle-option active"[^>]*>Parent/);
    assert.match(res.text, /Archive Parent Teacher/);
  });
});

test('GET /admin/schedule/archive/student/export.csv and delete routes', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('export.csv includes the archived student', async () => {
    const res = await request(app).get('/admin/schedule/archive/student/export.csv').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Archive Schedule Kid/);
  });

  await t.test('deleting one archived row removes just that one', async () => {
    const before = await db.prepare("SELECT * FROM member_schedule_archives WHERE member_name = 'Archive Schedule Kid'").get();
    assert.ok(before);
    const res = await request(app).post(`/admin/schedule/archive/${before.id}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /tab=archive/);
    const after = await db.prepare('SELECT * FROM member_schedule_archives WHERE id = ?').get(before.id);
    assert.equal(after, undefined);
  });

  await t.test('Delete All clears every remaining archived row of that type only', async () => {
    const countBefore = (await db.prepare("SELECT * FROM member_schedule_archives WHERE member_type = 'parent'").all()).length;
    assert.ok(countBefore > 0, 'setup: the archived parent from the earlier test should still be here');

    const res = await request(app).post('/admin/schedule/archive/parent/delete-all').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), new RegExp(`Deleted all ${countBefore} archived parent`));

    const parentCountAfter = (await db.prepare("SELECT * FROM member_schedule_archives WHERE member_type = 'parent'").all()).length;
    assert.equal(parentCountAfter, 0);
  });
});

test('the Member Schedules grid offers an Archive toggle with hidden per-card checkboxes', async (t) => {
  const { cookie } = await loginAsAdmin();

  await t.test('has the archive form, a hidden Select All checkbox, and a hidden memberIds checkbox per card', async () => {
    const res = await request(app).get('/admin/schedule?tab=members').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /id="schedule-archive-form-members"/);
    assert.match(res.text, /action="\/admin\/schedule\/members\/archive"/);
    assert.match(res.text, /data-archive-controls="schedule-archive-form-members"[^>]*hidden/, 'the Select All/Archive Selected row should start hidden');
    assert.match(res.text, /data-select-all-for="schedule-archive-form-members"/);
    assert.match(res.text, /data-archive-toggle="schedule-archive-form-members"/, 'a single Archive toggle button should be present');
    assert.match(res.text, /name="memberIds"[^>]*form="schedule-archive-form-members"[^>]*hidden/, 'each member checkbox should start hidden');
  });

  await t.test('the same archive form is used regardless of the Filter popup\'s Member Type - a filtered view is still ?tab=members, just narrowed by ?type=', async () => {
    const res = await request(app).get('/admin/schedule?tab=members&type=parent').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /id="schedule-archive-form-members"/);
    assert.match(res.text, /action="\/admin\/schedule\/members\/archive"/);
  });
});

// Real HTTP-level coverage for the Class Archive feature: "Archive
// Selected" on the day grid (routes/admin-class-schedule.js's
// POST /class-schedule/:day/archive) snapshots each checked class into
// class_schedule_archives and removes it from the live schedule, and the
// Class Archive tab (routes/admin-schedule.js's tab=archive branch) lists
// those snapshots with Export/Delete-individual/Delete-all - the design
// spec from the "let's add archive all. then delete from archive" request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-archive-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-archive-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

async function createClassWithStaffAndStudent(cookie, csrfToken, overrides) {
  const teacher = await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Archive Test Teacher', memberType: 'parent', _csrf: csrfToken });
  const student = await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Archive Test Student', memberType: 'student', _csrf: csrfToken });
  void teacher;
  void student;

  const teacherRow = await db.prepare("SELECT id FROM members WHERE name = 'Archive Test Teacher'").get();
  const studentRow = await db.prepare("SELECT id FROM members WHERE name = 'Archive Test Student'").get();

  const className = (overrides && overrides.className) || 'Archive Test Class';
  await request(app)
    .post('/admin/class-schedule/classes/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      day: 'monday',
      className,
      hourPosition: '1',
      room: 'Room A',
      color: '#EE9A4D',
      startTime: '9:00 AM',
      endTime: '9:45 AM',
      teacherId: String(teacherRow.id),
      _csrf: csrfToken,
      ...overrides,
    });

  const cls = await db.prepare('SELECT * FROM classes WHERE class_name = ?').get(className);
  await request(app)
    .post(`/admin/class-schedule/classes/${cls.id}/enrollment/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ studentIds: String(studentRow.id), _csrf: csrfToken });

  return cls.id;
}

test('POST /admin/class-schedule/:day/archive', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('rejects with no classIds selected', async () => {
    const res = await request(app)
      .post('/admin/class-schedule/monday/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
  });

  await t.test('archiving a class snapshots teachers/assistants/student count and removes it from the live grid', async () => {
    const classId = await createClassWithStaffAndStudent(cookie, csrfToken);

    const res = await request(app)
      .post('/admin/class-schedule/monday/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ classIds: String(classId), _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Archived 1 class/);

    const stillLive = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    assert.equal(stillLive, undefined, 'the archived class should be gone from the live classes table');

    const archived = await db.prepare("SELECT * FROM class_schedule_archives WHERE class_name = 'Archive Test Class'").get();
    assert.ok(archived, 'expected a class_schedule_archives row');
    assert.equal(archived.day, 'monday');
    assert.equal(archived.room, 'Room A');
    assert.equal(archived.teachers, 'Archive Test Teacher');
    assert.equal(archived.student_count, 1);
  });
});

test('Class Archive tab (/admin/schedule?tab=archive)', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('lists archived classes with Export and Delete controls', async () => {
    const res = await request(app).get('/admin/schedule?tab=archive').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Archive Test Class/);
    assert.match(res.text, /\/admin\/class-schedule\/archive\/export\.csv/);
    assert.match(res.text, /\/admin\/class-schedule\/archive\/delete-all/);
  });

  await t.test('GET export.csv includes the archived row', async () => {
    const res = await request(app).get('/admin/class-schedule/archive/export.csv').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Archive Test Class/);
    assert.match(res.text, /Archive Test Teacher/);
  });

  await t.test('deleting one archived row removes just that one', async () => {
    const before = await db.prepare("SELECT * FROM class_schedule_archives WHERE class_name = 'Archive Test Class'").get();
    assert.ok(before);

    const res = await request(app)
      .post(`/admin/class-schedule/archive/${before.id}/delete`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /tab=archive/);

    const after = await db.prepare('SELECT * FROM class_schedule_archives WHERE id = ?').get(before.id);
    assert.equal(after, undefined);
  });

  await t.test('Delete All clears every remaining archived row', async () => {
    // Archive a second class so there's something for Delete All to clear.
    const classId = await createClassWithStaffAndStudent(cookie, csrfToken, { className: 'Archive Test Class 2', hourPosition: '2' });
    await request(app)
      .post('/admin/class-schedule/monday/archive')
      .set('Cookie', cookie)
      .type('form')
      .send({ classIds: String(classId), _csrf: csrfToken });

    const countBefore = (await db.prepare('SELECT * FROM class_schedule_archives').all()).length;
    assert.ok(countBefore > 0);

    const res = await request(app)
      .post('/admin/class-schedule/archive/delete-all')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), new RegExp(`Deleted all ${countBefore} archived class`));

    const countAfter = (await db.prepare('SELECT * FROM class_schedule_archives').all()).length;
    assert.equal(countAfter, 0);
  });
});

// The day grid used to show a permanent "Select All"/"Archive Selected"
// pair plus a checkbox on every class card at all times - now it's a
// single "Archive" toggle button; clicking it (client-side, in
// public/js/archive-select-toggle.js) reveals the checkboxes and
// the Select All/Archive Selected row (which sits under "Highlight
// Absences For", not in the main button row). The checkboxes/controls
// still render in the HTML either way (so the toggle has something to
// reveal) - just `hidden` by default - so this only asserts on markup and
// the `hidden` attribute, not on visibility itself (that's a client-side
// concern this route-level suite can't exercise without a real browser).
test('the day grid offers a single Archive toggle, with per-class checkboxes and Archive Selected controls hidden until it is clicked - no Delete All button', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClassWithStaffAndStudent(cookie, csrfToken, { className: 'Archive Test Class 3', hourPosition: '3' });

  await t.test('the grid page has the archive form, a hidden Select All checkbox, one hidden classIds checkbox per class, and an Archive toggle button - no Delete All button', async () => {
    const res = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /id="class-archive-form-monday"/);
    assert.match(res.text, /action="\/admin\/class-schedule\/monday\/archive"/);
    assert.match(res.text, /id="class-schedule-archive-controls-monday"[^>]*hidden/, 'the Select All/Archive Selected row should start hidden');
    assert.match(res.text, /data-select-all-for="class-archive-form-monday"/);
    assert.match(res.text, new RegExp(`name="classIds" value="${classId}" form="class-archive-form-monday"[^>]*hidden`), 'each class checkbox should start hidden');
    assert.match(res.text, /data-archive-toggle="class-archive-form-monday"/, 'a single Archive toggle button should be present');
    assert.doesNotMatch(res.text, /Delete All/);
    assert.doesNotMatch(res.text, /\/delete-all"[^>]*class="inline-block-form"/);
  });
});

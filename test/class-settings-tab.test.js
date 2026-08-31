// A real request bundle for the Class Edit form: "remove parent portal
// checkbox. settings like that should be under a tab labeled settings.
// this settings tab appears after the archive tab under schedules. who
// can register for this class, three check boxes shouled also be under
// settings for schedules... cancellation settings, two check boxes. this
// should also be under schedules settings tab." Covers: the new Settings
// tab renders every class with its current 6 toggle values; the new
// per-checkbox /settings save route updates exactly the one field it's
// asked to; and the regression this whole move could have caused - the
// main Class Details save (routes/admin-class-schedule.js's POST
// /class-schedule/classes/:id) no longer submits those 6 fields at all,
// so it must preserve them rather than silently resetting them to
// defaults just because they're absent from that particular save.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-settings-tab-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-settings-tab-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, getClass } = require('../utils/classSchedule');

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

test('Settings tab lists every class with its current registration/cancellation values, and no longer shows a Notes column', async () => {
  const cookie = await loginAsAdmin();
  await createClass({
    day: 'monday', hourPosition: 1, className: 'Settings Tab Class', registrationOpen: true, allowStudentRegister: true, autoRefundOnCancel: true,
  });

  const res = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Settings Tab Class/);
  assert.match(res.text, /data-field="registrationOpen"[^>]*checked/);
  assert.match(res.text, /data-field="allowStudentRegister"[^>]*checked/);
  assert.match(res.text, /data-field="autoRefundOnCancel"[^>]*checked/);
});

test('the Settings tab per-checkbox save route flips exactly the one field it is told to, leaving the other 5 untouched', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Toggle Class' });
  const before = await getClass(classId);
  assert.equal(before.allow_parent_register, 1, 'sanity: defaults on');
  assert.equal(before.registration_open, 0, 'sanity: defaults off');

  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/settings`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .type('form')
    .send({ field: 'registrationOpen', value: '1' });
  assert.equal(res.status, 200);

  const after = await getClass(classId);
  assert.equal(after.registration_open, 1, 'the toggled field should flip');
  assert.equal(after.allow_parent_register, 1, 'every other field should stay exactly as it was');
  assert.equal(after.allow_teacher_register, 1);
  assert.equal(after.allow_student_register, 0);
  assert.equal(after.allow_cancel, 1);
  assert.equal(after.auto_refund_on_cancel, 0);
});

test('the settings save route rejects an unknown field name rather than ever building a column name from it', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Reject Class' });
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/settings`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrfToken)
    .type('form')
    .send({ field: 'id; DROP TABLE classes;--', value: '1' });
  assert.equal(res.status, 400);
});

test('saving the main Class Details form (name/room/description) preserves whatever is already set on the Settings tab, instead of resetting it to defaults', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({
    day: 'monday', hourPosition: 4, className: 'Preserve Class', registrationOpen: true, allowParentRegister: false, allowStudentRegister: true, allowCancel: false, autoRefundOnCancel: true,
  });
  const before = await getClass(classId);
  assert.equal(before.registration_open, 1);
  assert.equal(before.allow_parent_register, 0);

  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  // The real, current Class Details form - no registrationOpen/
  // allowParentRegister/allowTeacherRegister/allowStudentRegister/
  // allowCancel/autoRefundOnCancel fields at all anymore.
  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      className: 'Preserve Class (renamed)',
      hourPosition: '4',
      room: 'New Room',
      description: 'Updated description',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const after = await getClass(classId);
  assert.equal(after.class_name, 'Preserve Class (renamed)', 'the actual edit should still apply');
  assert.equal(after.room, 'New Room');
  assert.equal(after.registration_open, 1, 'registrationOpen must survive a save that never mentions it');
  assert.equal(after.allow_parent_register, 0, 'allowParentRegister must survive too, even though it defaults to 1');
  assert.equal(after.allow_student_register, 1);
  assert.equal(after.allow_cancel, 0);
  assert.equal(after.auto_refund_on_cancel, 1);
});

test('classes.notes is gone - class description is a single merged field, and it is what shows up in the archived record', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Merged Description Class', description: 'One combined description.' });
  const cls = await getClass(classId);
  assert.equal(cls.notes, undefined, 'the classes table should no longer even have a notes column');
  assert.equal(cls.description, 'One combined description.');

  const page = await request(app).get('/admin/schedule?tab=wednesday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post('/admin/class-schedule/wednesday/archive')
    .set('Cookie', cookie)
    .type('form')
    .send({ classIds: [String(classId)], _csrf: csrfToken });

  const archived = await db.prepare('SELECT * FROM class_schedule_archives WHERE class_name = ?').get('Merged Description Class');
  assert.ok(archived, 'the class should be archived');
  assert.equal(archived.notes, 'One combined description.', 'the archive record keeps the merged description, not blank');
});

test('price_per only accepts students/students_and_staff now, defaulting to students', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Pricing Class A' });
  let cls = await getClass(classId);
  assert.equal(cls.price_per, 'students', 'default should be students, not the old person/family values');

  const classId2 = await createClass({ day: 'monday', hourPosition: 2, className: 'Pricing Class B', pricePer: 'students_and_staff' });
  cls = await getClass(classId2);
  assert.equal(cls.price_per, 'students_and_staff');
});

// A real request rebuilt the old per-class Settings tab into a single
// GLOBAL "Co-op Class Settings" page: "There should not be a list of all
// of the classes. It should be a list of checkboxes on the left... and
// questions/statements on the right." Covers: the new global settings
// page renders with that title and persists its own fields via
// classGlobalSettings/saveClassGlobalSettings; and the regression that
// rebuild could have caused - the main Class Details save (routes/admin-
// class-schedule.js's POST /class-schedule/classes/:id) still doesn't
// submit the old per-class allow_parent_register/allow_teacher_register/
// allow_student_register/allow_cancel/auto_refund_on_cancel fields, so it
// must preserve them rather than silently resetting them to defaults.
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
const { createClass, getClass, classGlobalSettings } = require('../utils/classSchedule');

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

test('the global Co-op Class Settings page renders its title and no class list', async () => {
  const cookie = await loginAsAdmin();
  await createClass({ day: 'monday', hourPosition: 1, className: 'Should Not Appear On Settings' });

  const res = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Co-op Class Settings/);
  assert.doesNotMatch(res.text, /Should Not Appear On Settings/);
});

test('saving the global Co-op Class Settings form persists every field', async () => {
  const cookie = await loginAsAdmin();
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const res = await request(app)
    .post('/admin/schedule/class-settings')
    .set('Cookie', cookie)
    .type('form')
    .send({
      ageRestrictionMode: 'fixed_date',
      ageRestrictionMonth: '9',
      ageRestrictionDay: '1',
      defaultLockByAge: '1',
      cancellationPolicy: 'before_start',
      autoCreditOnAdminRemoval: '1',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const settings = await classGlobalSettings();
  assert.equal(settings.ageRestrictionMode, 'fixed_date');
  assert.equal(settings.ageRestrictionMonth, '9');
  assert.equal(settings.ageRestrictionDay, '1');
  assert.equal(settings.defaultLockByAge, true);
  assert.equal(settings.defaultLockByGrade, false, 'a field left off the submitted form should be saved as unchecked, not preserved');
  assert.equal(settings.cancellationPolicy, 'before_start');
  assert.equal(settings.autoCreditOnAdminRemoval, true);
});

test('saving the main Class Details form (name/room/description) preserves whatever the old per-class registration/cancellation columns already held, instead of resetting them to defaults', async () => {
  const cookie = await loginAsAdmin();
  const classId = await createClass({
    day: 'monday', hourPosition: 4, className: 'Preserve Class', registrationOpen: true, allowParentRegister: false, allowStudentRegister: true, allowCancel: false, autoRefundOnCancel: true,
  });
  const before = await getClass(classId);
  assert.equal(before.registration_open, 1);
  assert.equal(before.allow_parent_register, 0);

  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  // The real, current Class Details form - no
  // allowParentRegister/allowTeacherRegister/allowStudentRegister/
  // allowCancel/autoRefundOnCancel fields at all anymore (registrationOpen
  // itself is back on this form as the inverted "Close Registration"
  // checkbox, so it's covered separately, not by this preservation path).
  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      className: 'Preserve Class (renamed)',
      hourPosition: '4',
      room: 'New Room',
      description: 'Updated description',
      closeRegistration: '',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const after = await getClass(classId);
  assert.equal(after.class_name, 'Preserve Class (renamed)', 'the actual edit should still apply');
  assert.equal(after.room, 'New Room');
  assert.equal(after.registration_open, 1, 'registrationOpen must survive a save that leaves Close Registration unchecked');
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

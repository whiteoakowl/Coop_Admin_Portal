// A real request: "Individual class editing. Add a duplicate class
// button at the bottom. Clicking this button allows you to duplicate
// the class, all of its details and settings. When you click this
// button it will ask you, do you want to copy the same teachers and
// class assistants, it will also have a drop down menu to ask which
// semester/day it will be added to. Duplicate of class will then appear
// on the other semester/day grid." Covers: the dialog on the Details
// tab, duplicating onto a different day/semester combo with every
// Details/Slots/Sections field carried over, the copy-staff checkbox
// (both on and off), and that enrollment/students are never copied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-duplicate-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-duplicate-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, getClass, addStaff } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function classScheduleIdForDay(day) {
  const row = await db.prepare('SELECT id FROM class_schedules WHERE day_of_week = ? AND semester_id IS NULL').get(day);
  return row.id;
}

test('the Details tab has a Duplicate Class button and dialog with a copy-staff checkbox and a semester/day dropdown', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Pottery' });

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Duplicate Class/);
  assert.match(page.text, /id="duplicate-class-dialog"/);
  assert.match(page.text, new RegExp(`action="/admin/class-schedule/classes/${classId}/duplicate"`));
  assert.match(page.text, /name="copyStaff" value="1"/);
  assert.match(page.text, /<select name="targetComboId" required>/);
  assert.match(page.text, />Monday</);
  assert.match(page.text, />Wednesday</);
});

test('duplicating a class onto a different day copies every detail/slot/section field but not enrollment, and staff only if asked', async () => {
  const admin = await loginAsAdmin();

  const sectionInfo = await db.prepare("INSERT INTO sections (name) VALUES ('Teen Co-op')").run();
  const sectionId = sectionInfo.lastInsertRowid;

  const classId = await createClass({
    day: 'monday',
    hourPosition: 2,
    className: 'Chemistry Lab',
    room: 'Room B',
    ageGroup: 'Grade 9',
    numericAges: '14,15',
    color: '#AABBCC',
    startTime: '10:00 AM',
    endTime: '11:00 AM',
    startDate: '2026-09-01',
    endDate: '2026-12-01',
    capacity: 12,
    registrationOpen: true,
    description: 'Hands-on chemistry.',
    supplyList: 'Goggles, gloves.',
    teacherSlots: 2,
    assistantSlots: 1,
    minCapacity: 3,
    priceCents: 2500,
    pricePer: 'students_and_staff',
  });
  await db.prepare('INSERT INTO class_sections (class_id, section_id) VALUES (?, ?)').run(classId, sectionId);

  const teacherInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Dup Teacher', 'dup-teacher', 'parent', 1)").run();
  await addStaff(classId, teacherInfo.lastInsertRowid, 'teacher');

  const studentInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Dup Student', 'dup-student', 'student', 1)").run();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, studentInfo.lastInsertRowid);

  const wednesdayScheduleId = await classScheduleIdForDay('wednesday');

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/duplicate`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ targetComboId: String(wednesdayScheduleId), copyStaff: '1', _csrf: admin.csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Duplicated as "Chemistry Lab"/);

  const dup = await db.prepare("SELECT * FROM classes WHERE class_name = 'Chemistry Lab' AND day = 'wednesday'").get();
  assert.ok(dup, 'the duplicate should exist on Wednesday');
  assert.equal(dup.room, 'Room B');
  assert.equal(dup.age_group, 'Grade 9');
  assert.equal(dup.numeric_ages, '14,15');
  assert.equal(dup.color, '#AABBCC');
  assert.equal(dup.start_time, '10:00 AM');
  assert.equal(dup.end_time, '11:00 AM');
  assert.equal(dup.start_date, '2026-09-01');
  assert.equal(dup.end_date, '2026-12-01');
  assert.equal(dup.capacity, 12);
  assert.equal(dup.registration_open, 1);
  assert.equal(dup.description, 'Hands-on chemistry.');
  assert.equal(dup.supply_list, 'Goggles, gloves.');
  assert.equal(dup.teacher_slots, 2);
  assert.equal(dup.assistant_slots, 1);
  assert.equal(dup.min_capacity, 3);
  assert.equal(dup.price_cents, 2500);
  assert.equal(dup.price_per, 'students_and_staff');

  const dupSections = await db.prepare('SELECT section_id FROM class_sections WHERE class_id = ?').all(dup.id);
  assert.deepEqual(dupSections.map((r) => r.section_id), [sectionId], 'section restriction should carry over');

  const dupStaff = await getClass(dup.id);
  assert.equal(dupStaff.staff.length, 1, 'the teacher should have been copied since copyStaff was checked');
  assert.equal(dupStaff.staff[0].name, 'Dup Teacher');

  assert.equal(dupStaff.students.length, 0, 'enrollment should never be copied onto a duplicate');
});

test('duplicating without checking "copy staff" leaves the new class with no staff', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Art Studio' });
  const teacherInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Solo Art Teacher', 'solo-art-teacher', 'parent', 1)").run();
  await addStaff(classId, teacherInfo.lastInsertRowid, 'teacher');

  const mondayScheduleId = await classScheduleIdForDay('monday');
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}/duplicate`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ targetComboId: String(mondayScheduleId), _csrf: admin.csrfToken });

  const dup = await db.prepare("SELECT * FROM classes WHERE class_name = 'Art Studio' AND id != ?").get(classId);
  assert.ok(dup, 'duplicating onto the SAME day/semester combo should still work (a second class row)');
  const dupWithStaff = await getClass(dup.id);
  assert.equal(dupWithStaff.staff.length, 0, 'staff should not be copied when the checkbox was left unchecked');
});

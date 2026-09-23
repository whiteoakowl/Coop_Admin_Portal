// Real requests bundled together:
// 1. "Co-op admin, classes, grade and age should have a checkbox that
//    says lock class by grade or lock class by age."
// 2. "Add close registration check box on detail page."
// 3. "# of students, # of teachers. # of class assistants options should
//    move to the top of staff and roster page."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-grade-age-lock-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-grade-age-lock-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, getClass } = require('../utils/classSchedule');
const { registerForClass } = require('../utils/classRegistration');

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
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createFamilyStudent(overrides) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Lock Family ${familyCounter}`)).id;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Lock Parent ${familyCounter}`, `lock-parent-${familyCounter}`, familyId)
  ).id;
  const studentId = (
    await db
      .prepare(
        "INSERT INTO members (name, barcode, member_type, family_id, grade_level, birthday, active) VALUES (?, ?, 'student', ?, ?, ?, 1) RETURNING id"
      )
      .get(`Lock Student ${familyCounter}`, `lock-student-${familyCounter}`, familyId, (overrides && overrides.gradeLevel) || null, (overrides && overrides.birthday) || null)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `lock-parent-${familyCounter}@example.com`;
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, email, hashPassword('testpassword123'))
  ).id;
  return { familyId, parentId, studentId, acctId };
}

test('Class Details tab: Lock by Grade / Lock by Age checkboxes render checked by default, and Close Registration checkbox reflects registration_open', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Lock Checkbox Class', registrationOpen: true });

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<input type="checkbox" name="lockByGrade" value="1" checked \/> Lock class by grade/);
  assert.match(page.text, /<input type="checkbox" name="lockByAge" value="1" checked \/> Lock class by age/);
  // registration is open, so the "Close Registration" box should be unchecked.
  assert.match(page.text, /<input type="checkbox" name="closeRegistration" value="1"\s*\/> Close Registration/);
});

test('Unchecking Lock by Grade stops enforcing the grade restriction at registration time', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({
    day: 'monday', hourPosition: 2, className: 'Grade Restricted Class', ageGroup: 'Grade 5', registrationOpen: true,
  });
  const { parentId, studentId, acctId } = await createFamilyStudent({ gradeLevel: 'Grade 2' });

  // With lock_by_grade still on (default), a mismatched grade is rejected.
  const rejected = await registerForClass({ classId, studentId, accountId: acctId, portalRoles: ['parent'], registrantType: 'parent' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /eligible grade level/);

  // Uncheck Lock by Grade via the Details form.
  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Grade Restricted Class', hourPosition: '2', ageGroup: 'Grade 5', _csrf: csrfToken });
  const cls = await getClass(classId);
  assert.equal(Number(cls.lock_by_grade), 0, 'unchecked checkbox should turn lock_by_grade off');

  const allowed = await registerForClass({ classId, studentId, accountId: acctId, portalRoles: ['parent'], registrantType: 'parent' });
  assert.equal(allowed.ok, true, 'grade mismatch should no longer block registration once lock_by_grade is off');
  void parentId;
});

test('Close Registration checkbox flips registration_open (checkbox checked = closed)', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Close Reg Class', registrationOpen: true });

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Close Reg Class', hourPosition: '3', closeRegistration: '1', _csrf: csrfToken });

  const cls = await getClass(classId);
  assert.equal(Number(cls.registration_open), 0, 'checking Close Registration should close it');

  // Unchecking it (omitting the field, matching how an unchecked HTML checkbox submits) reopens it.
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Close Reg Class', hourPosition: '3', _csrf: csrfToken });
  const reopened = await getClass(classId);
  assert.equal(Number(reopened.registration_open), 1);
});

test('Staff & Roster tab has its own Slots form at the top, and saving it does not disturb the Class Details fields', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({
    day: 'monday', hourPosition: 4, className: 'Slots Move Class', room: 'Room 9', description: 'Keep this description',
  });

  const rosterPage = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=staffRoster`).set('Cookie', admin.cookie);
  assert.equal(rosterPage.status, 200);
  assert.match(rosterPage.text, /<h2>Slots<\/h2>/);
  assert.match(rosterPage.text, /action="\/admin\/class-schedule\/classes\/\d+\/slots"/);
  assert.match(rosterPage.text, /# of Students Allowed/);
  assert.match(rosterPage.text, /# of Teachers Allowed/);
  assert.match(rosterPage.text, /# of Class Assistants Allowed/);
  // The Details tab (Class Details form) should no longer carry these 3.
  const detailsPage = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  const detailsFormStart = detailsPage.text.indexOf('Class Details');
  const detailsFormEnd = detailsPage.text.indexOf('Save Changes');
  const detailsFormHtml = detailsPage.text.slice(detailsFormStart, detailsFormEnd);
  assert.doesNotMatch(detailsFormHtml, /# of Students Allowed/);
  assert.doesNotMatch(detailsFormHtml, /# of Teachers Allowed/);
  assert.doesNotMatch(detailsFormHtml, /# of Class Assistants Allowed/);
  assert.match(detailsFormHtml, /Minimum Students Needed/, 'Minimum Students Needed should stay on Details');

  const csrfToken = extractCsrf(rosterPage.text);
  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/slots`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ capacity: '10', teacherSlots: '2', assistantSlots: '3', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /tab=staffRoster/);

  const cls = await getClass(classId);
  assert.equal(cls.capacity, 10);
  assert.equal(cls.teacher_slots, 2);
  assert.equal(cls.assistant_slots, 3);
  assert.equal(cls.room, 'Room 9', 'saving Slots must not disturb the Class Details fields');
  assert.equal(cls.description, 'Keep this description');
});

test('Saving the Class Details form does not reset slot counts set on the Staff & Roster tab', async () => {
  const admin = await loginAsAdmin();
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Preserve Slots Class', capacity: 8, teacherSlots: 1, assistantSlots: 1 });

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage`).set('Cookie', admin.cookie);
  const csrfToken = extractCsrf(page.text);
  await request(app)
    .post(`/admin/class-schedule/classes/${classId}`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ className: 'Preserve Slots Class (renamed)', hourPosition: '1', _csrf: csrfToken });

  const cls = await getClass(classId);
  assert.equal(cls.class_name, 'Preserve Slots Class (renamed)');
  assert.equal(cls.capacity, 8, 'capacity must survive a Details save that never mentions it');
  assert.equal(cls.teacher_slots, 1);
  assert.equal(cls.assistant_slots, 1);
});

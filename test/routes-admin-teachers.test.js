// Coverage for Co-op Admin Portal > Teachers/Assistants - a real
// request: "Add a tab called Teachers/Assistants after the classes tab.
// Teachers/assistants shows a lost of Teachers and assistants organized
// by schedule grid semester with a dropdown filter. If a teacher teaches
// multiple classes they will all be listed under the members name with a
// dropdown arrow and minimize feature. You can click on the class and it
// will go to the class. Organized alphabetical by last name. Subpage,
// instructor profiles, list of members who are signed up as teachers
// with check mark for enable/disable instructors profile. Click on each
// member and you can edit their instructor profile. It asks email, phone
// number, about me, experience/qualifications (check box for include
// this)." (routes/admin-teachers.js, views/admin-teachers*.ejs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-teachers-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-teachers-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/teachers').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let counter = 0;
async function createMember(name) {
  counter += 1;
  const code = `teacherstest${counter}`;
  return (await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, 'parent', 1) RETURNING id").get(name, code, code)).id;
}
async function createClass({ day, hourPosition, className, semesterId }) {
  return (
    await db
      .prepare('INSERT INTO classes (day, hour_position, class_name, semester_id) VALUES (?, ?, ?, ?) RETURNING id')
      .get(day, hourPosition, className, semesterId ?? null)
  ).id;
}
async function addStaff(classId, memberId, role) {
  await db.prepare('INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, ?)').run(classId, memberId, role);
}

test('Classes tab is immediately followed by Teachers/Assistants in the Co-op Admin nav', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  // Every top-level nav entry with its own subpages renders as "<label>
  // <svg class="icon admin-nav-group-chevron">" (views/partials/admin-nav.ejs) -
  // both Classes and the new Teachers/Assistants entry have subpages, so
  // this pulls the ordered list of every such top-level label and checks
  // Teachers/Assistants is the one immediately after Classes in it (the
  // desktop sidebar's own rendering - the first of admin-nav.ejs's two
  // renderings of the same array, so first-match order reflects it).
  const chevronLabels = [...res.text.matchAll(/>([A-Za-z/ -]+?) <svg class="icon admin-nav-group-chevron">/g)].map((m) => m[1].trim());
  const classesIndex = chevronLabels.indexOf('Classes');
  assert.ok(classesIndex !== -1, 'expected a Classes nav entry with subpages');
  assert.equal(chevronLabels[classesIndex + 1], 'Teachers/Assistants');
});

test('Teachers/Assistants list: alphabetical by last name, every member (including a single-class one) gets a collapsible details dropdown', async () => {
  const { cookie } = await loginAsAdmin();

  const zebraId = await createMember('Amy Zebra');
  const classZ = await createClass({ day: 'monday', hourPosition: 1, className: 'Art' });
  await addStaff(classZ, zebraId, 'teacher');

  const appleId = await createMember('Bob Apple');
  const classA1 = await createClass({ day: 'monday', hourPosition: 1, className: 'Science' });
  const classA2 = await createClass({ day: 'wednesday', hourPosition: 2, className: 'History' });
  await addStaff(classA1, appleId, 'teacher');
  await addStaff(classA2, appleId, 'assistant');

  const res = await request(app).get('/admin/teachers').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // "Organized alphabetical by last name" - Apple before Zebra.
  assert.ok(res.text.indexOf('Bob Apple') < res.text.indexOf('Amy Zebra'), 'Bob Apple (last name Apple) should come before Amy Zebra (last name Zebra)');

  // A real follow-up request: "even if the member is only teaching or
  // assisting 1 class it should still show as a drop down minimize
  // system so that you see just a list of member names" - a single-class
  // member now also gets a real <details>/<summary> wrapper, same as a
  // multi-class member, just with one <li> once expanded.
  const zebraSection = res.text.slice(res.text.indexOf('Amy Zebra') - 150, res.text.indexOf('Amy Zebra') + 400);
  assert.match(zebraSection, /<details>/, 'a member with only one class should still get a collapsible dropdown');
  assert.match(zebraSection, /1 class</, 'the summary should show a singular "1 class" count, not "1 classes"');
  assert.match(zebraSection, /Art/);

  // Multi-class member: real <details>/<summary> dropdown listing both
  // classes with their own role label.
  const appleSection = res.text.slice(res.text.indexOf('Bob Apple') - 150, res.text.indexOf('Bob Apple') + 1200);
  assert.match(appleSection, /<details>/, 'a member staffed on more than one class should get a collapsible dropdown');
  assert.match(appleSection, /2 classes</, 'the summary should show a plural "2 classes" count');
  assert.match(appleSection, /Science/);
  assert.match(appleSection, /History/);
  assert.match(appleSection, /Teacher/);
  assert.match(appleSection, /Assistant/);
});

test('Teachers/Assistants: semester dropdown filters the list to only that semester\'s classes', async () => {
  const { cookie } = await loginAsAdmin();

  const semA = (await db.prepare("INSERT INTO semesters (title) VALUES ('Fall Teachers Test') RETURNING id").get()).id;
  const semB = (await db.prepare("INSERT INTO semesters (title) VALUES ('Spring Teachers Test') RETURNING id").get()).id;

  const fallTeacherId = await createMember('Fall Teacherperson');
  const fallClass = await createClass({ day: 'monday', hourPosition: 1, className: 'Fall Only Class', semesterId: semA });
  await addStaff(fallClass, fallTeacherId, 'teacher');

  const springTeacherId = await createMember('Spring Teacherperson');
  const springClass = await createClass({ day: 'monday', hourPosition: 1, className: 'Spring Only Class', semesterId: semB });
  await addStaff(springClass, springTeacherId, 'teacher');

  const fallRes = await request(app).get(`/admin/teachers?semesterId=${semA}`).set('Cookie', cookie);
  assert.match(fallRes.text, /Fall Teacherperson/);
  assert.doesNotMatch(fallRes.text, /Spring Teacherperson/);

  const allRes = await request(app).get('/admin/teachers?semesterId=').set('Cookie', cookie);
  assert.match(allRes.text, /Fall Teacherperson/);
  assert.match(allRes.text, /Spring Teacherperson/);
});

test('Teachers/Assistants: a full admin clicking a class goes straight to its manage page', async () => {
  const { cookie } = await loginAsAdmin();
  const memberId = await createMember('Link Target Teacher');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Link Target Class' });
  await addStaff(classId, memberId, 'teacher');

  const res = await request(app).get('/admin/teachers').set('Cookie', cookie);
  assert.match(res.text, new RegExp(`href="/admin/class-schedule/classes/${classId}/manage"`));
});

test('Instructor Profiles subpage: lists only members staffed as teacher/assistant, with an enable/disable checkbox', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const instructorId = await createMember('Profile Instructor');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Profile Class' });
  await addStaff(classId, instructorId, 'teacher');

  await createMember('Not A Teacher');

  await t.test('only the staffed member appears, unchecked by default', async () => {
    const res = await request(app).get('/admin/teachers/instructor-profiles').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Profile Instructor/);
    assert.doesNotMatch(res.text, /Not A Teacher/);
    assert.match(res.text, new RegExp(`<input type="checkbox" name="enabled" value="1"  onchange="this\\.form\\.submit\\(\\)" aria-label="Enable instructor profile for Profile Instructor"`));
  });

  await t.test('toggling the checkbox enables the profile', async () => {
    await request(app).post(`/admin/teachers/instructor-profiles/${instructorId}/enabled`).set('Cookie', cookie).type('form').send({ enabled: '1', _csrf: csrfToken });
    const res = await request(app).get('/admin/teachers/instructor-profiles').set('Cookie', cookie);
    assert.match(res.text, new RegExp(`<input type="checkbox" name="enabled" value="1" checked onchange="this\\.form\\.submit\\(\\)" aria-label="Enable instructor profile for Profile Instructor"`));
  });

  await t.test('unchecking (an empty checkbox value) disables it again', async () => {
    await request(app).post(`/admin/teachers/instructor-profiles/${instructorId}/enabled`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    const res = await request(app).get('/admin/teachers/instructor-profiles').set('Cookie', cookie);
    assert.match(res.text, new RegExp(`<input type="checkbox" name="enabled" value="1"  onchange="this\\.form\\.submit\\(\\)" aria-label="Enable instructor profile for Profile Instructor"`));
  });
});

test('Instructor Profile edit form: saves email/phone/about me/qualifications + the "include this" checkbox, without touching enabled', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const instructorId = await createMember('Edit Form Instructor');
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Edit Form Class' });
  await addStaff(classId, instructorId, 'teacher');
  await request(app).post(`/admin/teachers/instructor-profiles/${instructorId}/enabled`).set('Cookie', cookie).type('form').send({ enabled: '1', _csrf: csrfToken });

  await t.test('GET the edit page shows blank fields for a never-edited profile', async () => {
    const res = await request(app).get(`/admin/teachers/instructor-profiles/${instructorId}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Instructor Profile - Edit Form Instructor/);
    assert.match(res.text, /name="qualificationsVisible"/);
  });

  await t.test('POST saves every field', async () => {
    await request(app)
      .post(`/admin/teachers/instructor-profiles/${instructorId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ email: 'teacher@example.com', phone: '555-1234', aboutMe: 'I love teaching.', qualifications: '10 years experience', qualificationsVisible: '1', _csrf: csrfToken });

    const row = await db.prepare('SELECT * FROM instructor_profiles WHERE member_id = ?').get(instructorId);
    assert.equal(row.email, 'teacher@example.com');
    assert.equal(row.phone, '555-1234');
    assert.equal(row.about_me, 'I love teaching.');
    assert.equal(row.qualifications, '10 years experience');
    assert.equal(Number(row.qualifications_visible), 1);
    assert.equal(Number(row.enabled), 1, 'saving the edit form should not have touched the separately-managed enabled flag');

    const editPage = await request(app).get(`/admin/teachers/instructor-profiles/${instructorId}/edit`).set('Cookie', cookie);
    assert.match(editPage.text, /value="teacher@example\.com"/);
    assert.match(editPage.text, /555-1234/);
    assert.match(editPage.text, /I love teaching\./);
  });
});

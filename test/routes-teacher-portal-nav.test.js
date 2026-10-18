// Real HTTP-level coverage for a real request: "Teacher portal dashboard
// add section for my classes tab. Each tab after that should be each
// class that teacher is signed up for to teach. Classes tab should be
// called co-op classes and have all the same subpages as parent portal
// co-op classes tab." Teacher Portal's own nav (views/partials/
// portal-nav.ejs's TEACHER_NAV_LINKS) was still a copy-pasted navLinks
// array in all 11 views/teacher-*.ejs files before this - centralized
// here the same way Main Admin/Parent/Student Portal's own nav already
// was, so every page gets the rename/new section automatically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-portal-nav-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-portal-nav-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let classCounter = 0;
async function makeClass(name, opts) {
  classCounter += 1;
  const day = (opts && opts.day) || 'monday';
  const hourPosition = (opts && opts.hourPosition) || 1;
  const semesterId = opts && opts.semesterId != null ? opts.semesterId : null;
  return (
    await db
      .prepare('INSERT INTO classes (day, hour_position, class_name, semester_id) VALUES (?, ?, ?, ?) RETURNING id')
      .get(day, hourPosition, name || `Teacher Nav Class ${classCounter}`, semesterId)
  ).id;
}

let teacherCounter = 0;
async function loginTeacher(classIds) {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Nav Test Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  for (const classId of classIds) {
    await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, memberId);
  }
  const email = `teacher-nav-${teacherCounter}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/teacher' });
  return loginRes.headers['set-cookie'];
}

test('Teacher Portal nav: "Classes" is renamed "Class Schedule", with no subpages', async () => {
  const classId = await makeClass();
  const cookie = await loginTeacher([classId]);
  const page = await request(app).get('/teacher').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, />Classes<\/a>/, 'the old plain "Classes" label should be gone');
  assert.doesNotMatch(page.text, />Co-op Classes/, 'the old "Co-op Classes" label should be gone');
  assert.match(page.text, /<a href="\/teacher\/classes">[\s\S]*?Class Schedule<\/a>/);
});

test('Teacher Portal Class Schedule tab: List view shows a day-by-day table of the classes this teacher teaches, no subpages', async () => {
  const classId = await makeClass('Schedule Tab Class');
  const cookie = await loginTeacher([classId]);
  const page = await request(app).get('/teacher/classes?view=list').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Class Schedule<\/h1>/);
  assert.match(page.text, /Schedule Tab Class/);
  assert.doesNotMatch(page.text, /View Roster/, 'the old per-class card grid should be gone');
});

// A real bug report: "Teacher portal isn't showing the class schedule at
// all" - List view defaulted this page, and a teacher with nothing
// staffed yet this semester saw nothing but "not staffed on any classes
// yet", with the actual co-op-wide schedule grid hidden a click away
// behind the Grid icon. Grid view is now the default, same as Parent
// Portal's own Class Registration page.
test('Teacher Portal Class Schedule tab: defaults to Grid view, has a Semester dropdown, a Print button, and Grid/List view icons', async () => {
  const fall = (await db.prepare("INSERT INTO semesters (title) VALUES ('Fall Nav Test') RETURNING id").get()).id;
  const spring = (await db.prepare("INSERT INTO semesters (title) VALUES ('Spring Nav Test') RETURNING id").get()).id;
  const fallClass = await makeClass('Fall Semester Class', { semesterId: fall });
  const springClass = await makeClass('Spring Semester Class', { day: 'wednesday', hourPosition: 2, semesterId: spring });
  const cookie = await loginTeacher([fallClass, springClass]);

  const allPage = await request(app).get('/teacher/classes').set('Cookie', cookie);
  assert.equal(allPage.status, 200);
  assert.match(allPage.text, /Semester/);
  assert.match(allPage.text, /Fall Semester Class/);
  assert.match(allPage.text, /Print/);
  assert.match(allPage.text, /aria-label="Grid view"/);
  assert.match(allPage.text, /aria-label="List view"/);
  assert.match(allPage.text, /class-schedule-room-grid/, 'the page should default to Grid view, not List');

  // List view (this teacher's own classes, grouped by day) - the
  // sidebar's own "My Classes" section (populated independently of this
  // page's semester filter) always lists both classes, so scope this
  // check to the schedule table's own day headings rather than the whole
  // page: Fall's class meets Monday, Spring's meets Wednesday.
  const fallOnly = await request(app).get(`/teacher/classes?view=list&semesterId=${fall}`).set('Cookie', cookie);
  assert.match(fallOnly.text, /<h2>Monday<\/h2>/);
  assert.doesNotMatch(fallOnly.text, /<h2>Wednesday<\/h2>/, 'picking one semester should hide classes from another');

  const gridView = await request(app).get('/teacher/classes?view=grid').set('Cookie', cookie);
  assert.equal(gridView.status, 200);
  assert.match(gridView.text, /class-schedule-room-grid/);
  assert.match(gridView.text, /Fall Semester Class/);
});

test('Teacher Portal Class Schedule tab: Grid view shows the entire co-op schedule grid for one day, not just this teacher\'s own classes - same page as Parent Portal\'s own Class Registration grid', async () => {
  const fall = (await db.prepare("INSERT INTO semesters (title) VALUES ('Fall Grid Test') RETURNING id").get()).id;
  const spring = (await db.prepare("INSERT INTO semesters (title) VALUES ('Spring Grid Test') RETURNING id").get()).id;
  const myClass = await makeClass('My Own Grid Class', { day: 'monday', hourPosition: 1, semesterId: fall });
  const otherTeacherClass = await makeClass('Someone Elses Grid Class', { day: 'monday', hourPosition: 2, semesterId: fall });
  const springOnlyClass = await makeClass('Spring Only Grid Class', { day: 'monday', hourPosition: 3, semesterId: spring });
  const cookie = await loginTeacher([myClass]);

  const allSemesters = await request(app).get('/teacher/classes?view=grid&day=monday').set('Cookie', cookie);
  assert.equal(allSemesters.status, 200);
  assert.match(allSemesters.text, /My Own Grid Class/);
  assert.match(allSemesters.text, /Someone Elses Grid Class/, 'the grid should show every class in the co-op, not just this teacher\'s own');
  assert.match(allSemesters.text, /Spring Only Grid Class/, '"All Semesters" should include every semester\'s classes');

  const fallOnly = await request(app).get(`/teacher/classes?view=grid&day=monday&semesterId=${fall}`).set('Cookie', cookie);
  assert.equal(fallOnly.status, 200);
  assert.match(fallOnly.text, /Someone Elses Grid Class/);
  assert.doesNotMatch(fallOnly.text, /Spring Only Grid Class/, 'the semester dropdown should scope the whole-co-op grid too');
});

// "Members can view whatever schedule grids are unlocked for members to
// see" - Teacher Portal is a member-facing portal too, so its Grid view
// now runs through the exact same visible_to_members browse-time gate
// (hideClassesNotVisibleToMembers) Parent Portal's own grid already did.
test('Teacher Portal Class Schedule tab: Grid view hides classes under a grid locked away from members, same as Parent Portal\'s grid', async () => {
  const semesterId = (await db.prepare("INSERT INTO semesters (title) VALUES ('Locked Grid Semester') RETURNING id").get()).id;
  await db
    .prepare('INSERT INTO class_schedules (title, day_of_week, semester_id, visible_to_members, visible_to_public) VALUES (?, ?, ?, 0, 0)')
    .run('Locked Tuesday', 'tuesday', semesterId);
  const lockedClass = await makeClass('Member-Locked Class', { day: 'tuesday', hourPosition: 1, semesterId });
  const cookie = await loginTeacher([lockedClass]);

  const page = await request(app).get(`/teacher/classes?view=grid&day=tuesday&semesterId=${semesterId}`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Member-Locked Class/, 'a class under a grid not visible to members should not appear, even to the teacher staffed on it');
});

test('Teacher Portal nav: a "My Classes" section lists one entry per class this teacher actually teaches', async () => {
  const classA = await makeClass('Nav My Classes A');
  const classB = await makeClass('Nav My Classes B');
  const otherClass = await makeClass('Nav Not My Class');
  const cookie = await loginTeacher([classA, classB]);

  const page = await request(app).get('/teacher').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /My Classes/);
  assert.match(page.text, new RegExp(`<a href="/teacher/classes/${classA}">[\\s\\S]*?Nav My Classes A</a>`));
  assert.match(page.text, new RegExp(`<a href="/teacher/classes/${classB}">[\\s\\S]*?Nav My Classes B</a>`));
  assert.doesNotMatch(page.text, /Nav Not My Class/, 'a class this teacher does not teach should not appear in My Classes');

  // The section follows this specific teacher's own roster, not a fixed
  // list - a teacher of only one class gets only one My Classes entry.
  const soloCookie = await loginTeacher([otherClass]);
  const soloPage = await request(app).get('/teacher').set('Cookie', soloCookie);
  assert.match(soloPage.text, /Nav Not My Class/);
  assert.doesNotMatch(soloPage.text, /Nav My Classes A/);
});

test('Teacher Portal nav: every page carries the same centralized nav, not a per-page copy', async () => {
  const classId = await makeClass();
  const cookie = await loginTeacher([classId]);
  for (const url of ['/teacher', '/teacher/classes', '/teacher/attendance', '/teacher/assignments']) {
    const res = await request(app).get(url).set('Cookie', cookie);
    assert.equal(res.status, 200, `expected ${url} to render`);
    assert.match(res.text, />Class Schedule/, `expected ${url} to show the renamed Class Schedule tab`);
  }
});

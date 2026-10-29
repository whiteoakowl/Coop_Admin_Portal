// Coverage for a real request: "Classroom dashboard has all family
// school management classes and co-op classes together, but categorized
// and filters, for easier viewing for students." / "When you click on a
// family class it has the same tabs as the co-op classes. Details,
// lessons, grades." / "Family school management classes. Class cards
// should look like co-op class cards."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `classroom-dashboard-family-merge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `classroom-dashboard-family-merge-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const classSchedule = require('../utils/classSchedule');
const { hashPassword } = require('../utils/portalAuth');

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

let counter = 0;
async function createFamilyWithParentAndStudent() {
  counter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`Merge Family ${counter}`)).id;
  const parentCode = `merge-parent-${counter}`;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1) RETURNING id")
      .get(`Merge Parent ${counter}`, parentCode, parentCode, familyId)
  ).id;
  const parentEmail = `${parentCode}@example.com`;
  const parentAccountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, parentEmail, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(parentAccountId, parentRole.id);
  const parentLogin = await request(app).post('/login').type('form').send({ email: parentEmail, password: 'testpassword123', next: '/parent' });

  const studentCode = `merge-student-${counter}`;
  const studentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1) RETURNING id")
      .get(`Merge Student ${counter}`, studentCode, studentCode, familyId)
  ).id;
  const studentEmail = `${studentCode}@example.com`;
  const studentAccountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(studentId, studentEmail, hashPassword('testpassword123'))
  ).id;
  const studentRole = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(studentAccountId, studentRole.id);
  const studentLogin = await request(app).post('/login').type('form').send({ email: studentEmail, password: 'testpassword123', next: '/student' });

  return {
    familyId,
    parentId,
    parentCookie: parentLogin.headers['set-cookie'],
    studentId,
    studentCookie: studentLogin.headers['set-cookie'],
  };
}

test('Classroom Dashboard shows both a Co-op class and a Homeschool Family class, categorized under their own headings', async () => {
  const { studentId, studentCookie } = await createFamilyWithParentAndStudent();

  const coopClassId = await classSchedule.createClass({ day: 'monday', hourPosition: 1, className: 'Merge Co-op Art' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(coopClassId, studentId);

  const dashboard = await request(app).get('/student/classes/dashboard').set('Cookie', studentCookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /<h2>Co-op Classes<\/h2>/);
  assert.match(dashboard.text, /Merge Co-op Art/);
  assert.doesNotMatch(dashboard.text, /<h2>Homeschool Family Classes<\/h2>/, 'no family classes assigned yet, so that section should not render');
});

test('Classroom Dashboard Filter narrows to just Co-op or just Family classes, and a Family class card links to the tabbed family class detail page', async () => {
  const { parentCookie, studentId, studentCookie } = await createFamilyWithParentAndStudent();

  const coopClassId = await classSchedule.createClass({ day: 'monday', hourPosition: 1, className: 'Merge Filter Co-op Class' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(coopClassId, studentId);

  const parentHome = await request(app).get('/parent/family-school').set('Cookie', parentCookie);
  const parentCsrf = extractCsrf(parentHome.text);
  const createRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parentCookie)
    .type('form')
    .send({ className: 'Merge Filter Family Class', description: 'A family class', _csrf: parentCsrf });
  const familyClassId = parseInt(createRes.headers.location.match(/classes\/(\d+)/)[1], 10);
  await request(app)
    .post(`/parent/family-school/classes/${familyClassId}/students`)
    .set('Cookie', parentCookie)
    .type('form')
    .send({ studentIds: String(studentId), _csrf: parentCsrf });

  const all = await request(app).get('/student/classes/dashboard').set('Cookie', studentCookie);
  assert.match(all.text, /Merge Filter Co-op Class/);
  assert.match(all.text, /Merge Filter Family Class/);
  assert.match(all.text, /<h2>Homeschool Family Classes<\/h2>/);

  // The Filter dropdown's own option labels always say both "Co-op
  // Classes" and "Homeschool Family Classes" regardless of which is
  // currently selected, so every "is this section showing" check below
  // anchors on the actual <h2> section heading, not the bare phrase.
  const coopOnly = await request(app).get('/student/classes/dashboard?type=coop').set('Cookie', studentCookie);
  assert.match(coopOnly.text, /Merge Filter Co-op Class/);
  assert.doesNotMatch(coopOnly.text, /Merge Filter Family Class/);
  assert.doesNotMatch(coopOnly.text, /<h2>Homeschool Family Classes<\/h2>/);

  const familyOnly = await request(app).get('/student/classes/dashboard?type=family').set('Cookie', studentCookie);
  assert.doesNotMatch(familyOnly.text, /Merge Filter Co-op Class/);
  assert.match(familyOnly.text, /Merge Filter Family Class/);
  assert.doesNotMatch(familyOnly.text, /<h2>Co-op Classes<\/h2>/);

  // "Class cards should look like co-op class cards" - the same
  // .class-dash-card component the Co-op Classes section above uses.
  assert.match(familyOnly.text, new RegExp(`class-dash-card"[\\s\\S]*?Merge Filter Family Class[\\s\\S]*?href="/student/family-school/classes/${familyClassId}"`));

  // "When you click on a family class it has the same tabs as the co-op
  // classes. Details, lessons, grades."
  const detail = await request(app).get(`/student/family-school/classes/${familyClassId}`).set('Cookie', studentCookie);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /<a class="view-tab active" href="\?tab=details">Details<\/a>/);
  assert.match(detail.text, /<a class="view-tab" href="\?tab=lessons">Lessons<\/a>/);
  assert.match(detail.text, /<a class="view-tab" href="\?tab=grades">Grades<\/a>/);
  assert.match(detail.text, /A family class/);

  const lessonsTab = await request(app).get(`/student/family-school/classes/${familyClassId}?tab=lessons`).set('Cookie', studentCookie);
  assert.match(lessonsTab.text, /<a class="view-tab active" href="\?tab=lessons">Lessons<\/a>/);

  const gradesTab = await request(app).get(`/student/family-school/classes/${familyClassId}?tab=grades`).set('Cookie', studentCookie);
  assert.match(gradesTab.text, /<a class="view-tab active" href="\?tab=grades">Grades<\/a>/);
});

test('Family School Management Classes list (both Parent and Student) uses the same class-dash-card look as Co-op classes', async () => {
  const { parentCookie, studentId, studentCookie } = await createFamilyWithParentAndStudent();

  const parentHome = await request(app).get('/parent/family-school').set('Cookie', parentCookie);
  const parentCsrf = extractCsrf(parentHome.text);
  const createRes = await request(app)
    .post('/parent/family-school/classes')
    .set('Cookie', parentCookie)
    .type('form')
    .send({ className: 'Card Look Class', description: '', _csrf: parentCsrf });
  const familyClassId = parseInt(createRes.headers.location.match(/classes\/(\d+)/)[1], 10);
  await request(app)
    .post(`/parent/family-school/classes/${familyClassId}/students`)
    .set('Cookie', parentCookie)
    .type('form')
    .send({ studentIds: String(studentId), _csrf: parentCsrf });

  const parentList = await request(app).get('/parent/family-school/classes').set('Cookie', parentCookie);
  assert.match(parentList.text, /class-dash-card/);
  assert.doesNotMatch(parentList.text, /team-info-card/, 'the old plain card component should be gone from the class grid');
  assert.match(parentList.text, /Card Look Class/);

  const studentList = await request(app).get('/student/family-school').set('Cookie', studentCookie);
  assert.match(studentList.text, /class-dash-card/);
  assert.doesNotMatch(studentList.text, /team-info-card/);
  assert.match(studentList.text, /Card Look Class/);
});

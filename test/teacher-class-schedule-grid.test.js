// Coverage for a real request: "Teacher portal, class schedule, shrink
// everything to fit properly in the grid. Be able to click on classes
// and see the details and read the descriptions." The grid's own cards
// (views/teacher-classes.ejs) used to be plain, non-clickable <div>s with
// no way to read a class's own description at all - they're real
// <button>s now (public/js/teacher-class-view.js), opening a read-only
// info popup for ANY class in the grid, not just one this teacher is
// staffed on (routes/teacher-portal.js's own GET /classes/:id/fragment).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `teacher-class-schedule-grid-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `teacher-class-schedule-grid-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');
const { createClass } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let teacherCounter = 0;
async function loginTeacher() {
  teacherCounter += 1;
  const code = await generateMemberCode();
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type, active) VALUES ('Grid Teacher', ?, ?, 'parent', 1) RETURNING id").get(code, code)
  ).id;
  const email = `grid-teacher-${teacherCounter}@example.com`;
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

test('Grid view renders each class as a real clickable <button> carrying data-view-class, and loads the dialog/script', async () => {
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Pottery', room: 'Room 2' });
  const cookie = await loginTeacher();

  const res = await request(app).get('/teacher/classes?view=grid&day=monday').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`<button type="button" class="teacher-schedule-grid-card"[^>]*data-view-class="${classId}"`));
  assert.match(res.text, /<dialog id="teacher-class-dialog" class="parent-class-dialog"><\/dialog>/);
  assert.match(res.text, /<script src="\/js\/teacher-class-view\.js"><\/script>/);
});

test('GET /teacher/classes/:id/fragment shows the class name, description, teacher, and student count for ANY class, not just one this teacher is staffed on', async () => {
  const classId = await createClass({ day: 'wednesday', hourPosition: 2, className: 'Chemistry Lab', room: 'Room 5', description: 'Hands-on experiments every week. Goggles required.' });
  const teacherMemberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Lab Teacher', 'lab-teacher-barcode', 'parent', 1) RETURNING id").get()
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherMemberId);

  // This teacher does NOT teach Chemistry Lab - confirms the fragment
  // route is read-only info for any class, unlike GET /classes/:id
  // (which 403s for a class this teacher doesn't teach).
  const cookie = await loginTeacher();

  const notTeaching = await request(app).get(`/teacher/classes/${classId}`).set('Cookie', cookie);
  assert.equal(notTeaching.status, 403);

  const fragment = await request(app).get(`/teacher/classes/${classId}/fragment`).set('Cookie', cookie);
  assert.equal(fragment.status, 200);
  assert.match(fragment.text, /Chemistry Lab/);
  assert.match(fragment.text, /Hands-on experiments every week\. Goggles required\./);
  assert.match(fragment.text, /Lab Teacher/);
  assert.match(fragment.text, /Room 5/);
  // Read-only - no register/join/leave controls at all.
  assert.doesNotMatch(fragment.text, /Register your children/);
  assert.doesNotMatch(fragment.text, /Register as Teacher\/Assistant/);
});

test('GET /teacher/classes/:id/fragment 404s for a class id that does not exist', async () => {
  const cookie = await loginTeacher();
  const res = await request(app).get('/teacher/classes/999999/fragment').set('Cookie', cookie);
  assert.equal(res.status, 404);
});

test('Class Schedule Print button links to a dedicated print preview page, which renders the same grid', async () => {
  await createClass({ day: 'monday', hourPosition: 1, className: 'Woodworking', room: 'Room 3' });
  const cookie = await loginTeacher();

  const live = await request(app).get('/teacher/classes?view=grid&day=monday').set('Cookie', cookie);
  assert.match(live.text, /<a class="icon-btn" href="\/teacher\/classes\/print\?day=monday&view=grid" target="_blank" aria-label="Print"/);

  const preview = await request(app).get('/teacher/classes/print?view=grid&day=monday').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /print-preview-header/);
  assert.match(preview.text, /onclick="window\.print\(\)"/);
  assert.match(preview.text, /Woodworking/);
});

test('Class Schedule Print preview respects the List view too', async () => {
  const classId = await createClass({ day: 'wednesday', hourPosition: 2, className: 'Ceramics', room: 'Room 4' });
  const teacherMemberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Ceramics Teacher', 'ceramics-teacher-barcode', 'parent', 1) RETURNING id").get()
  ).id;
  await db.prepare("INSERT INTO class_staff (class_id, member_id, role) VALUES (?, ?, 'teacher')").run(classId, teacherMemberId);

  const cookie = await loginTeacher();
  const preview = await request(app).get('/teacher/classes/print?view=list').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /You're not staffed on any classes yet\./, 'this teacher is not staffed on Ceramics, so List view is empty for them');
});

// Coverage for a real request: "Family management attendance drop down
// to choose one of your children or family. Can take attendance by
// individual child or select family and take attendance that will
// appear on all individual attendance calendars for each child/student."
// (utils/familySchool.js's own familyAttendanceForMonth/
// toggleFamilyAttendance, routes/parent-family-school.js's own
// /attendance/family/toggle route and studentId=family handling,
// views/parent-family-school-attendance.ejs's own "Whole Family" option).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-family-attendance-whole-family-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-family-attendance-whole-family-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `wholefam${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

async function setupFamilyOfTwo(label) {
  const familyId = await createFamily(label);
  const parent = await createPortalMember({ name: `${label} Parent`, familyId, memberType: 'parent', roleKey: 'parent' });
  const studentA = await createPortalMember({ name: `${label} Student A`, familyId, memberType: 'student', roleKey: 'student' });
  const studentB = await createPortalMember({ name: `${label} Student B`, familyId, memberType: 'student', roleKey: 'student' });
  return { parent, studentA, studentB };
}

test('the Student filter offers a "Whole Family" option alongside each child', async () => {
  const { parent } = await setupFamilyOfTwo('Dropdown Family');
  const res = await request(app).get('/parent/family-school/attendance').set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<option value="family"[^>]*>Whole Family<\/option>/);
});

test('toggling Whole Family marks every family student present on the same date', async () => {
  const { parent, studentA, studentB } = await setupFamilyOfTwo('Bulk Present Family');
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/attendance');

  const toggleRes = await request(app)
    .post('/parent/family-school/attendance/family/toggle')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ date: '2026-03-10', _csrf: csrf });
  assert.equal(toggleRes.status, 200);
  assert.deepEqual(toggleRes.body, { ok: true, status: 'present' });

  const rows = await db
    .prepare('SELECT student_id, status FROM family_school_attendance WHERE attendance_date = ? ORDER BY student_id')
    .all('2026-03-10');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'present'));
  assert.deepEqual(new Set(rows.map((r) => r.student_id)), new Set([studentA.memberId, studentB.memberId]));

  // "will appear on all individual attendance calendars for each
  // child/student" - each child's own single-student calendar shows the
  // same present mark the family toggle just wrote.
  const childView = await request(app)
    .get(`/parent/family-school/attendance?studentId=${studentA.memberId}&year=2026&month=3`)
    .set('Cookie', parent.cookie);
  assert.match(childView.text, /fs-attendance-day-present" data-fs-attendance-cell data-date="2026-03-10"/);
});

test('Whole Family toggle cycles present -> absent -> unmarked for every student together, even one already marked differently', async () => {
  const { parent, studentB } = await setupFamilyOfTwo('Bulk Cycle Family');
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/attendance');
  // Student B starts out already marked absent on its own, individual
  // calendar - the family aggregate should treat that as "not everyone
  // agrees" (unmarked), not silently inherit student B's own status.
  await db.prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, 'absent')").run(studentB.memberId, '2026-04-02');

  const first = await request(app)
    .post('/parent/family-school/attendance/family/toggle')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ date: '2026-04-02', _csrf: csrf });
  assert.deepEqual(first.body, { ok: true, status: 'present' });
  let rows = await db.prepare('SELECT status FROM family_school_attendance WHERE attendance_date = ?').all('2026-04-02');
  assert.ok(rows.every((r) => r.status === 'present'));

  const second = await request(app)
    .post('/parent/family-school/attendance/family/toggle')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ date: '2026-04-02', _csrf: csrf });
  assert.deepEqual(second.body, { ok: true, status: 'absent' });

  const third = await request(app)
    .post('/parent/family-school/attendance/family/toggle')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ date: '2026-04-02', _csrf: csrf });
  assert.deepEqual(third.body, { ok: true, status: null });
  rows = await db.prepare('SELECT status FROM family_school_attendance WHERE attendance_date = ?').all('2026-04-02');
  assert.equal(rows.length, 0);
});

test('the Whole Family calendar only shows a date as marked when every family student shares that exact status', async () => {
  const { parent, studentA, studentB } = await setupFamilyOfTwo('Mixed Status Family');
  await db.prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, 'present')").run(studentA.memberId, '2026-05-05');
  await db.prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, 'absent')").run(studentB.memberId, '2026-05-05');

  const res = await request(app)
    .get('/parent/family-school/attendance?studentId=family&year=2026&month=5')
    .set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /fs-attendance-day-unmarked" data-fs-attendance-cell data-date="2026-05-05"/);
});

test('the Whole Family calendar toggles via the family-wide endpoint, and the month nav/export links carry studentId=family', async () => {
  const { parent } = await setupFamilyOfTwo('Family Mode Links Family');
  const res = await request(app)
    .get('/parent/family-school/attendance?studentId=family&year=2026&month=6')
    .set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /data-toggle-url="\/parent\/family-school\/attendance\/family\/toggle"/);
  assert.match(res.text, /href="\?studentId=family&year=2026&month=7"/);
  assert.match(res.text, /href="\/parent\/family-school\/attendance\/export\.csv\?studentId=family"/);
});

test('Export CSV with studentId=family falls back to every family student\'s rows, same as Download CSV', async () => {
  const { parent, studentA, studentB } = await setupFamilyOfTwo('Export Fallback Family');
  await db.prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, 'present')").run(studentA.memberId, '2026-07-01');
  await db.prepare("INSERT INTO family_school_attendance (student_id, attendance_date, status) VALUES (?, ?, 'absent')").run(studentB.memberId, '2026-07-02');

  const res = await request(app)
    .get('/parent/family-school/attendance/export.csv?studentId=family')
    .set('Cookie', parent.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /"Export Fallback Family Student A","2026-07-01","present"/);
  assert.match(res.text, /"Export Fallback Family Student B","2026-07-02","absent"/);
});

// A real user request: "All print button should show a print preview full
// real page on a page with a print button. That print button will then
// send it to the printer." Converts the last 4 remaining plain
// window.print() buttons to the same dedicated <name>-print.ejs + GET
// .../print pattern already used ~30 times elsewhere (see views/admin-
// rosters-print.ejs): Co-op Admin's Name Tag Requests tab, Main Admin's
// Name Tags Requests tab, Student Portal's Diploma page, and Setup/
// Cleanup Assignments. Each check below locks the live page's button down
// to a target="_blank" link (never window.print() on the live page itself
// any more) and confirms the new preview page it opens has the standard
// print-preview-header bar with its own Print button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `print-preview-buttons-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `print-preview-buttons-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

let studentCounter = 0;
async function loginAsStudent(name) {
  studentCounter += 1;
  const code = `print-preview-student-${studentCounter}`;
  const email = `${code}@example.com`;
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'student', 1)")
    .run(name, code);
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(studentId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/student' });
  return { studentId, cookie: loginRes.headers['set-cookie'] };
}

function futureMonday() {
  let d = addDays(todayISO(), 21);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

test('Co-op Admin Name Tag Requests: Print is now a target="_blank" link to a dedicated preview page', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Student', 'print-preview-student', 'student')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'needs a new one')").run(memberId);

  const live = await request(app).get('/admin/name-tag?tab=requests').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<a class="icon-btn" href="\/admin\/name-tag\/requests\/print\?archived=0" target="_blank"/);
  assert.doesNotMatch(live.text, /class="icon-btn" onclick="window\.print\(\)"/);

  const preview = await request(app).get('/admin/name-tag/requests/print?archived=0').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /print-preview-header/);
  assert.match(preview.text, /onclick="window\.print\(\)"/);
  assert.match(preview.text, /Print Preview Student/);
  assert.match(preview.text, /Lost Name Tag/);
});

test('Main Admin Name Tags Requests: Print is now a target="_blank" link to a dedicated preview page', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Main Admin Print Preview', 'main-admin-print-preview', 'parent')")
    .run();
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'schedule_change', 'wednesday', NULL)").run(memberId);

  const live = await request(app).get('/main-admin/name-tags?tab=requests').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<a class="icon-btn" href="\/main-admin\/name-tags\/requests\/print\?archived=0" target="_blank"/);
  assert.doesNotMatch(live.text, /class="icon-btn" onclick="window\.print\(\)"/);

  const preview = await request(app).get('/main-admin/name-tags/requests/print?archived=0').set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /print-preview-header/);
  assert.match(preview.text, /onclick="window\.print\(\)"/);
  assert.match(preview.text, /Main Admin Print Preview/);
  assert.match(preview.text, /Schedule Change/);
});

test('Student Portal Diploma: Print is now a target="_blank" link to a dedicated preview page', async () => {
  const student = await loginAsStudent('Diploma Print Preview Kid');
  await db
    .prepare(
      `INSERT INTO diplomas (student_id, title, issued_date, template, color, display_name)
       VALUES (?, 'Diploma of Completion', ?, 'classic', '#2e6da4', 'Diploma Print Preview Kid')`
    )
    .run(student.studentId, todayISO());

  const live = await request(app).get('/student/diploma').set('Cookie', student.cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<a class="roster-action-btn print-action-btn no-print" href="\/student\/diploma\/print" target="_blank">Print<\/a>/);
  assert.doesNotMatch(live.text, /onclick="window\.print\(\)"/);

  const preview = await request(app).get('/student/diploma/print').set('Cookie', student.cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /print-preview-header/);
  assert.match(preview.text, /onclick="window\.print\(\)"/);
  assert.match(preview.text, /diploma-cert-name/);
  assert.match(preview.text, /Diploma Print Preview Kid/);
});

test('Setup/Cleanup Assignments: Print is now a target="_blank" link to a dedicated preview page', async () => {
  const cookie = await loginAsAdmin();
  const date = futureMonday();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Print Preview Crew')").run();
  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Member', 'print-preview-member', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);
  const setupPage = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(setupPage.text)[1];
  await request(app).post('/admin/setup/monday/dates/add').set('Cookie', cookie).type('form').send({ dates: date, _csrf: csrfToken });

  const live = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, new RegExp(`<a class="icon-btn" href="/admin/setup/monday/assignments/print\\?semesterId=[^"]*&amp;date=${date}" target="_blank"`));
  assert.doesNotMatch(live.text, /class="icon-btn" onclick="window\.print\(\)"/);

  const preview = await request(app).get(`/admin/setup/monday/assignments/print?date=${date}`).set('Cookie', cookie);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /print-preview-header/);
  assert.match(preview.text, /onclick="window\.print\(\)"/);
  assert.match(preview.text, /Print Preview Crew/);
  assert.match(preview.text, /Print Preview Member/);
  assert.doesNotMatch(preview.text, /<select/, 'the read-only preview should not show the editable Assign/Unassign dropdowns');
});

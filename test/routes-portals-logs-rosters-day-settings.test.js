// More real gaps found auditing the rest of the app for leftover 2-day
// utils/days.js consumers, after the Kiosk/Dashboard/Name-Tags/Member-
// Schedules/Substitutes-board generalization passes: Parent Portal's own
// public Class Registration page and Classroom Dashboard, Student
// Portal's Classroom Dashboard and Transcript, the shared portal-profile
// Schedules tab, the Membership Form's Setup/Cleanup Team dropdown, the
// Logs page's Class Cancellation Risk/Substitutes Needed tabs, and
// utils/rosterGrid.js's own Setup/Cleanup task-badge lookup were all
// still hardcoded to exactly Monday/Wednesday - some 404ing, some just
// silently never showing a 3rd+ day's own data at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portals-logs-rosters-day-settings-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portals-logs-rosters-day-settings-test-uploads-${process.pid}`);
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
const { generateMemberCode } = require('../utils/members');

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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function activateTuesday(admin) {
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Tuesday Enrichment', dayOfWeek: 'tuesday', _csrf: admin.csrfToken });
}

let familyCounter = 0;
async function createParentWithChild() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Portal Day Family ${familyCounter}`)).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Portal Day Parent ${familyCounter}`, parentCode, parentCode, familyId);
  const childCode = await generateMemberCode();
  const childInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'student', ?, 1)")
    .run(`Portal Day Child ${familyCounter}`, childCode, childCode, familyId);
  const email = `portal-day-parent${familyCounter}@example.com`;
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie, childId: childInfo.lastInsertRowid };
}

let studentCounter = 0;
async function createStudentAccount(name) {
  studentCounter += 1;
  const barcode = `portal-day-student-${studentCounter}`;
  const email = `portal-day-student-${studentCounter}@example.com`;
  const memberId = (await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(name, barcode, 'student')).lastInsertRowid;
  const accountId = (
    await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'active')").run(memberId, email, hashPassword('testpassword123'))
  ).lastInsertRowid;
  const role = await db.prepare("SELECT id FROM roles WHERE key = 'student'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const res = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { memberId, cookie: res.headers['set-cookie'] };
}

test('Parent Portal: /parent/classes offers a Tuesday tab, and a parent can register a child for a Tuesday class', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Pottery', registrationOpen: true });

  const page = await request(app).get('/parent/classes?day=tuesday').set('Cookie', (await createParentWithChild()).cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="day-toggle-option active" href="\/parent\/classes\?day=tuesday"/);
  assert.match(page.text, /Tuesday Pottery/);

  const parent = await createParentWithChild();
  const classesPage = await request(app).get('/parent/classes?day=tuesday').set('Cookie', parent.cookie);
  const csrfToken = extractCsrf(classesPage.text);
  const registerRes = await request(app)
    .post(`/parent/classes/${classId}/register`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: String(parent.childId), day: 'tuesday', _csrf: csrfToken });
  assert.equal(registerRes.status, 302);
  assert.match(registerRes.headers.location, /\/parent\/classes\?day=tuesday&/, 'registering from the Tuesday grid should redirect back to Tuesday, not reset to the default day');

  const enrolled = await db.prepare('SELECT 1 FROM class_enrollments WHERE class_id = ? AND student_id = ?').get(classId, parent.childId);
  assert.ok(enrolled, 'the registration must have actually saved');
});

test('Parent Portal Classroom Dashboard groups a Tuesday-enrolled class under its own "Tuesday" heading', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 2, className: 'Tuesday Chess Club' });
  const parent = await createParentWithChild();
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, parent.childId);

  const dashboard = await request(app).get(`/parent/classes/dashboard?studentId=${parent.childId}`).set('Cookie', parent.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /<h2>Tuesday<\/h2>/);
  assert.match(dashboard.text, /Tuesday Chess Club/);
});

test('Student Portal Classroom Dashboard groups a Tuesday-enrolled class under its own "Tuesday" heading', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const student = await createStudentAccount('Portal Day Student');
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 3, className: 'Tuesday Band' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.memberId);

  const dashboard = await request(app).get('/student/classes/dashboard').set('Cookie', student.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /<h2>Tuesday<\/h2>/);
  assert.match(dashboard.text, /Tuesday Band/);
});

test('Student Portal Transcript shows "Tuesday", not a hardcoded Monday/Wednesday fallback', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const student = await createStudentAccount('Portal Day Transcript Student');
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Transcript Class' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.memberId);

  const transcript = await request(app).get('/student/transcript').set('Cookie', student.cookie);
  assert.equal(transcript.status, 200);
  assert.match(transcript.text, /Tuesday Transcript Class/);
  const rowStart = transcript.text.indexOf('Tuesday Transcript Class');
  const rowEnd = transcript.text.indexOf('</tr>', rowStart);
  assert.match(transcript.text.slice(rowStart, rowEnd), />Tuesday<\/td>/);
});

test('Student Portal "My Classes" day-filter toggle offers a Tuesday button, not just All/Monday/Wednesday', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const student = await createStudentAccount('Portal Day Filter Student');
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Filter Class' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, student.memberId);

  const page = await request(app).get('/student/classes').set('Cookie', student.cookie);
  assert.equal(page.status, 200);
  assert.match(
    page.text,
    /<button type="button" class="day-toggle-option" data-filter="tuesday">Tuesday<\/button>/,
    'the day-filter toggle used to hardcode just All/Monday/Wednesday buttons, so a Tuesday class had no way to filter down to it'
  );
  assert.match(page.text, /<div class="class-card" data-day="tuesday">/);
});

test('portal-profile Schedules tab shows "Tuesday" for a family member\'s Tuesday class', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const parent = await createParentWithChild();
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Tuesday Profile Class' });
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classId, parent.childId);

  const profile = await request(app).get('/portal/profile?tab=schedules').set('Cookie', parent.cookie);
  assert.equal(profile.status, 200);
  assert.match(profile.text, /Tuesday Profile Class/);
  const rowStart = profile.text.indexOf('Tuesday Profile Class');
  const rowBefore = profile.text.slice(0, rowStart);
  const rowStartTr = rowBefore.lastIndexOf('<tr>');
  assert.match(profile.text.slice(rowStartTr, rowStart), />Tuesday<\/td>/);
});

test("the Membership Form's Setup/Cleanup Team dropdown shows \"Tuesday\" for a Tuesday-day team", async () => {
  const admin = await loginAsAdmin();
  await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('tuesday', 'Tuesday Crew')").run();

  const page = await request(app).get('/admin/members/new').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Tuesday &ndash; Tuesday Crew/);
});

test('Logs: Class Cancellation Risk and Substitutes Needed tabs work for Tuesday, not just Monday/Wednesday', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  const riskPage = await request(app).get('/admin/logs?tab=classrisk&day=tuesday').set('Cookie', admin.cookie);
  assert.equal(riskPage.status, 200);
  assert.match(riskPage.text, /class="day-toggle-option active" href="\/admin\/logs\?tab=classrisk&day=tuesday"/);

  const subsPage = await request(app).get('/admin/logs?tab=substitutes&day=tuesday').set('Cookie', admin.cookie);
  assert.equal(subsPage.status, 200);
  assert.match(subsPage.text, /day=tuesday/);
});

test("a Tuesday Attendance roster's ACTUALLY-SCANNED Setup/Cleanup task shows up, not silently blank", async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);

  const rosterId = (await db.prepare("SELECT id FROM rosters WHERE category = 'Class Schedule' AND schedule_day = 'tuesday' AND name LIKE '%Student%'").get()).id;
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Tuesday Cleanup Student', 'tuesday-cleanup-student', 'student')").run()
  ).lastInsertRowid;
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, memberId);
  const today = '2026-05-05';
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time) VALUES (?, ?, ?, 'present', ?)").run(memberId, rosterId, today, Date.now());

  const sectionId = (await db.prepare("INSERT INTO task_list_sections (day, title) VALUES ('tuesday', 'Tuesday Snack Team')").run()).lastInsertRowid;
  const itemId = (await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, ?)').run(sectionId, 'Tuesday Task 1', 0)).lastInsertRowid;
  await db
    .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, task_item_id, check_out_time) VALUES (?, ?, ?, ?, ?)')
    .run(memberId, rosterId, today, itemId, Date.now());

  const res = await request(app).get('/admin/rosters?tab=tuesday-student').set('Cookie', admin.cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Tuesday Cleanup Student/);
  const rowStart = res.text.indexOf('Tuesday Cleanup Student');
  const rowEnd = res.text.indexOf('</tr>', rowStart);
  assert.match(
    res.text.slice(rowStart, rowEnd),
    /Tuesday Snack Team-#1/,
    'the batch arrival/departure + cleanup-task lookup used to gate on a literal monday/wednesday check and silently skip any 3rd+ day'
  );
});

test('the Dashboard "Co-op Member Counts" card shows a Tuesday column with its own counts, not just Monday/Wednesday', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Dashboard Tuesday Class' });
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Dashboard Tuesday Student', 'dashboard-tuesday-student', 'student')")
    .run();
  await classSchedule.setEnrollment(classId, [studentId]);

  const dashboard = await request(app).get('/admin').set('Cookie', admin.cookie);
  assert.equal(dashboard.status, 200);
  assert.match(
    dashboard.text,
    /family-student-day-header family-student-day-header-(orange|blue)">[\s\S]*?Tuesday/,
    'the Co-op Member Counts card used to hardcode exactly Monday+Wednesday columns, so a 3rd+ day never showed up at all'
  );
});

test('the Members page Day filter offers and correctly filters by Tuesday', async () => {
  const admin = await loginAsAdmin();
  await activateTuesday(admin);
  const classId = await classSchedule.createClass({ day: 'tuesday', hourPosition: 1, className: 'Members Day Filter Tuesday Class' });
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Members Day Filter Tuesday Student', 'members-day-filter-tuesday-student', 'student')")
    .run();
  await classSchedule.setEnrollment(classId, [studentId]);

  const page = await request(app).get('/admin/members?day=tuesday').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Members Day Filter Tuesday Student/);
  assert.match(page.text, /<option value="[^"]*day=tuesday[^"]*"[^>]* selected>Tuesday<\/option>/);

  const mondayFiltered = await request(app).get('/admin/members?day=monday').set('Cookie', admin.cookie);
  assert.doesNotMatch(mondayFiltered.text, /Members Day Filter Tuesday Student/, 'a Tuesday-only member must not show under the Monday filter');
});

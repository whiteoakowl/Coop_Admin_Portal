// Real HTTP-level coverage for the Setup/Cleanup Assignments roster's
// "late" highlight (partials/setup-assignment-cards.ejs) - a real bug
// report: "Green for checked in, yellow for late, red for absent, red for
// checked out should only be highlighted on the member name, not the task
// rows." Late had no highlight at all before this - utils/setup.js's
// assignmentCardsForDate now also reads utils/classSchedule.js's new
// lateMemberIdsForDate (status = 'late' on attendance, same shape as the
// existing absentMemberIdsForDate). Mirrors
// test/routes-setup-checked-in-highlight.test.js's own admin-side setup
// almost exactly - same setup_dates/assignmentCardsForDate machinery,
// same partial - just keyed off attendance.status = 'late' instead of a
// real check-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-late-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-late-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { lateMemberIdsForDate } = require('../utils/classSchedule');

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

const today = todayISO();

test('utils/classSchedule.js lateMemberIdsForDate', async () => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: lateId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Late Person', 'unit-test-late', 'parent')")
    .run();
  const { lastInsertRowid: notLateId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Not Late Person', 'unit-test-nlate', 'parent')")
    .run();
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-01-05', 'late', 'absence_form')")
    .run(lateId, rosterId);

  const ids = await lateMemberIdsForDate('2026-01-05');
  assert.ok(ids.has(lateId));
  assert.ok(!ids.has(notLateId));
  assert.equal((await lateMemberIdsForDate('2026-01-06')).size, 0, 'a date with no late marks returns nothing');
  assert.equal((await lateMemberIdsForDate('')).size, 0, 'an empty date returns an empty set rather than matching everything');
});

test('Setup/Cleanup Assignments: a late member\'s NAME is highlighted yellow (not their task cells), and they can still be assigned a task', async () => {
  const cookie = await loginAsAdmin();

  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Late Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: lateMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Late Volunteer', 'late-monday', 'late-monday', 'parent')")
    .run();
  const { lastInsertRowid: notLateMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Not Late Volunteer', 'nlate-monday', 'nlate-monday', 'parent')")
    .run();

  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'late', 'absence_form')")
    .run(lateMemberId, rosterId, today);

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Late Chairs & Tables')").run();
  await db
    .prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?), (?, ?)')
    .run(teamId, lateMemberId, teamId, notLateMemberId);
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run('monday', today);
  const { lastInsertRowid: sectionId } = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Late Tasks', ?, 0)")
    .run(teamId);
  const { lastInsertRowid: taskItemId } = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)')
    .run(sectionId, 'Set up tables');

  const pageRes = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  assert.equal(pageRes.status, 200);
  assert.match(
    pageRes.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-late">\s*<a class="member-name-link"[^>]*>Late Volunteer/,
    'the late member\'s name cell should be highlighted yellow'
  );
  assert.doesNotMatch(
    pageRes.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-late">\s*<a class="member-name-link"[^>]*>Not Late Volunteer/,
    'a member who is not late is never highlighted'
  );

  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(pageRes.text)[1];
  const res = await request(app)
    .post(`/admin/setup/monday/assignments/${lateMemberId}/task`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date: today, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('Setup/Cleanup Assignments: an absent member is highlighted absent, not late, even if somehow both are true', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Late Precedence Roster', 'Class Schedule')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Both Late Flags Volunteer', 'both-late-flags', 'both-late-flags', 'parent')")
    .run();
  const { lastInsertRowid: roster2Id } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Late Precedence Roster 2', 'Class Schedule')").run();
  // Two different rosters disagreeing on the same date - 'absent' still
  // wins (missingMemberIdsForDate's own precedence, mirrored here).
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')")
    .run(memberId, rosterId, today);
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'late', 'absence_form')")
    .run(memberId, roster2Id, today);

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('wednesday', 'Late Precedence Team')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run('wednesday', today);

  const res = await request(app).get('/admin/setup/wednesday/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-absent">\s*<a class="member-name-link"[^>]*>Both Late Flags Volunteer/,
    'absent takes precedence over late when both are true'
  );
  assert.doesNotMatch(
    res.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-late">\s*<a class="member-name-link"[^>]*>Both Late Flags Volunteer/
  );
});

// Real HTTP-level coverage for the Setup/Cleanup Assignments roster's
// checked-out highlight (partials/setup-assignment-cards.ejs) - a real
// request: "if someone checks out, it should highlight their name yellow
// on the setup/cleanup assignment page and you won't be allowed to assign
// a job to them." Mirrors test/routes-setup-checked-in-highlight.test.js's
// own admin-side setup almost exactly - same setup_dates/
// assignmentCardsForDate machinery, same partial - just keyed off an
// actual kiosk checkout (the checkouts table) instead of a check-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-checked-out-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-checked-out-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { checkedOutMemberIdsForDate } = require('../utils/classSchedule');

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

test('utils/classSchedule.js checkedOutMemberIdsForDate', async () => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: checkedOutId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Checked Out Person', 'unit-test-co', 'parent')")
    .run();
  const { lastInsertRowid: notCheckedOutId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Not Checked Out Person', 'unit-test-nco', 'parent')")
    .run();
  await db
    .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, check_out_time) VALUES (?, ?, ?, ?)')
    .run(checkedOutId, rosterId, '2026-01-05', 1736100000000);

  const ids = await checkedOutMemberIdsForDate('2026-01-05');
  assert.ok(ids.has(checkedOutId));
  assert.ok(!ids.has(notCheckedOutId));
  assert.equal((await checkedOutMemberIdsForDate('2026-01-06')).size, 0, 'a date with no checkouts returns nothing');
  assert.equal((await checkedOutMemberIdsForDate('')).size, 0, 'an empty date returns an empty set rather than matching everything');
});

test('Setup/Cleanup Assignments: a checked-out member\'s whole row is highlighted (yellow - see styles.css), and assigning them a task is blocked', async (t) => {
  const cookie = await loginAsAdmin();

  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Checkout Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: checkedOutMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Checked Out Volunteer', 'co-monday', 'co-monday', 'parent')")
    .run();
  const { lastInsertRowid: notCheckedOutMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Not Checked Out Volunteer', 'nco-monday', 'nco-monday', 'parent')")
    .run();

  await db
    .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, check_out_time) VALUES (?, ?, ?, ?)')
    .run(checkedOutMemberId, rosterId, today, Date.now());

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Checkout Chairs & Tables')").run();
  await db
    .prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?), (?, ?)')
    .run(teamId, checkedOutMemberId, teamId, notCheckedOutMemberId);
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run('monday', today);

  const pageRes = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(pageRes.text)[1];

  await t.test('admin Assignments tab highlights the checked-out member', async () => {
    assert.equal(pageRes.status, 200);
    assert.match(
      pageRes.text,
      /<tr class="setup-assignment-row-checked-out">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Checked Out Volunteer/,
      'the checked-out member should be highlighted'
    );
    assert.doesNotMatch(
      pageRes.text,
      /<tr class="setup-assignment-row-checked-out">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Not Checked Out Volunteer/,
      'a member who never checked out is never highlighted'
    );
  });

  await t.test('server rejects assigning a task to a checked-out member even if the request is forced', async () => {
    const res = await request(app)
      .post(`/admin/setup/monday/assignments/${checkedOutMemberId}/task`)
      .set('Cookie', cookie)
      .set('X-Requested-With', 'fetch')
      .type('form')
      .send({ date: today, slot: '1', taskItemId: '999999', _csrf: csrfToken });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /checked out/i);
  });
});

test('Setup/Cleanup Assignments: an absent member is highlighted absent, not checked-out, even if somehow both are true', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Checkout Precedence Roster', 'Class Schedule')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Both Checkout Flags Volunteer', 'both-co-flags', 'both-co-flags', 'parent')")
    .run();
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')")
    .run(memberId, rosterId, today);
  await db
    .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, check_out_time) VALUES (?, ?, ?, ?)')
    .run(memberId, rosterId, today, Date.now());

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('wednesday', 'Checkout Precedence Team')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run('wednesday', today);

  const res = await request(app).get('/admin/setup/wednesday/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    /<tr class="setup-assignment-row-absent">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Both Checkout Flags Volunteer/,
    'absent takes precedence over checked-out when both are true'
  );
  assert.doesNotMatch(
    res.text,
    /<tr class="setup-assignment-row-checked-out">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Both Checkout Flags Volunteer/
  );
});

// A real request: "Create a co-op admin log for each day of scheduled
// classes that makes a list of the parent members who don't scan a
// setup/cleanup badge and parent who don't check in or submit an
// absence form and are a no show completely... organized by the date
// and next to each member it will show how many times they have missed
// scanning the setup/cleanup badge and how many times they didn't
// checkin or submit an absence for the day." Covers routes/admin-
// logs.js's missedSetupCleanupRows/noShowRows/missedDutyRows: a missed
// scan (assigned but no real badge scan), a no-show (no check-in AND no
// absence form), a member who did the right thing on both counts (must
// never appear), and the running-total math across multiple dates
// including a same-day double-flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `missed-duty-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `missed-duty-log-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { ensureDayMemberRosters } = require('../utils/classSchedule');

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

let mondayParentRosterId;
let missedMemberId; // misses the setup/cleanup scan on two separate dates
let goodMemberId; // assigned + actually scans, and checks in - must never appear
let excusedMemberId; // never checks in, but DOES submit an absence form - must never appear
let doubleFlagMemberId; // misses scan AND is a no-show on the very same date

test.before(async () => {
  await app.ready;

  const dayRosterIds = await ensureDayMemberRosters();
  mondayParentRosterId = dayRosterIds.monday.parent;

  const { lastInsertRowid: familyId } = await db.prepare("INSERT INTO families (name) VALUES ('Missed Duty Test Family')").run();

  async function insertParent(name, barcode) {
    const { lastInsertRowid: id } = await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES (?, ?, 'parent', ?)")
      .run(name, barcode, familyId);
    await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(mondayParentRosterId, id);
    return id;
  }

  missedMemberId = await insertParent('Missed Scan Parent', 'missed-duty-missed');
  goodMemberId = await insertParent('Compliant Parent', 'missed-duty-good');
  // No-show member - never checks in, never submits an absence. Nothing
  // afterward needs this id back directly, only the name "No Show
  // Parent" (checked via CSV text below).
  await insertParent('No Show Parent', 'missed-duty-noshow');
  excusedMemberId = await insertParent('Excused Parent', 'missed-duty-excused');
  doubleFlagMemberId = await insertParent('Double Flag Parent', 'missed-duty-double');

  // Two past Mondays this roster actually met, so roster_dates has rows
  // for the no-show query to walk.
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(mondayParentRosterId, '2024-03-04');
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(mondayParentRosterId, '2024-03-11');

  // setup_task_assignments.task_item_id is FK-constrained to a real
  // task_list_items row - minimal chain, same shape test/routes-setup-
  // task-complete-badge.test.js seeds.
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Missed Duty Test Team')").run();
  const { lastInsertRowid: sectionId } = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Missed Duty Test Tasks', ?, 0)")
    .run(teamId);
  const { lastInsertRowid: taskItemId } = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)')
    .run(sectionId, 'Sweep floor');

  // --- Setup/Cleanup assignments: real suggestions on both dates for the
  // missed/good/double-flag members (never for the no-show/excused ones -
  // they're only testing the no-show path, not setup/cleanup at all). ---
  const insertAssignment = db.prepare(
    'INSERT INTO setup_task_assignments (day, member_id, session_date, task_item_id) VALUES (?, ?, ?, ?)'
  );
  await insertAssignment.run('monday', missedMemberId, '2024-03-04', taskItemId);
  await insertAssignment.run('monday', missedMemberId, '2024-03-11', taskItemId);
  await insertAssignment.run('monday', goodMemberId, '2024-03-04', taskItemId);
  await insertAssignment.run('monday', doubleFlagMemberId, '2024-03-04', taskItemId);

  // goodMemberId actually scans on 2024-03-04 (real badge scan columns,
  // same shape test/routes-setup-task-complete-badge.test.js seeds).
  await db
    .prepare(
      `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source, task_item_id, task_scanned_at)
       VALUES (?, ?, '2024-03-04', 'present', ?, 'kiosk', ?, ?)`
    )
    .run(goodMemberId, mondayParentRosterId, Date.now(), taskItemId, Date.now());

  // goodMemberId also genuinely checks in on both dates (no-show side).
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2024-03-11', 'present', ?, 'kiosk')`)
    .run(goodMemberId, mondayParentRosterId, Date.now());

  // missedMemberId checks in on both dates (so only the scan miss should
  // flag them, never a no-show).
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2024-03-04', 'present', ?, 'kiosk')`)
    .run(missedMemberId, mondayParentRosterId, Date.now());
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2024-03-11', 'present', ?, 'kiosk')`)
    .run(missedMemberId, mondayParentRosterId, Date.now());

  // excusedMemberId: no check-in, but a real absence_submissions row on
  // BOTH roster dates - must never appear as a no-show on either.
  const insertAbsence = db.prepare(
    "INSERT INTO absence_submissions (member_id, roster_id, session_date, status, reason_category, reason_text) VALUES (?, ?, ?, 'absent', 'personal', 'testing')"
  );
  await insertAbsence.run(excusedMemberId, mondayParentRosterId, '2024-03-04');
  await insertAbsence.run(excusedMemberId, mondayParentRosterId, '2024-03-11');

  // doubleFlagMemberId genuinely checks in on 2024-03-11 (the roster's
  // other meeting date) - only 2024-03-04 should flag them, and only for
  // the setup/cleanup miss (no-show) since they never checked in THAT day.
  await db
    .prepare(`INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source) VALUES (?, ?, '2024-03-11', 'present', ?, 'kiosk')`)
    .run(doubleFlagMemberId, mondayParentRosterId, Date.now());

  // noShowMemberId: nothing inserted for either date - the absence of a
  // row IS the no-show, on both 2024-03-04 and 2024-03-11.
});

test('missedDutyRows / routes-admin-logs.js tab=missedduty', async (t) => {
  // Reach the private builder functions indirectly through the route
  // itself (not exported) - same approach every other *-pagination.test.js
  // file in this repo already takes for this page's other tabs.
  const cookie = await loginAsAdmin();

  await t.test('a member assigned a task but who never scanned appears as Missed Setup/Cleanup, running count increments across dates', async () => {
    const res = await request(app).get('/admin/logs?tab=missedduty').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Missed Scan Parent/);
    // Two separate assignment dates, both missed - the CSV export is the
    // simplest place to assert the exact running-count numbers without
    // scraping the accordion HTML.
    const csv = await request(app).get('/admin/logs/missedduty/export.csv').set('Cookie', cookie);
    const lines = csv.text.trim().split('\n');
    const missedRows = lines.filter((l) => l.includes('Missed Scan Parent'));
    assert.equal(missedRows.length, 2, 'expected one CSV row per date the scan was missed');
    // Row order is newest-first - 2024-03-11 (2nd miss, total 2) before
    // 2024-03-04 (1st miss, total 1).
    const [newer, older] = missedRows;
    assert.match(newer, /,"2"(,|$)/, `expected the 2024-03-11 row to show a running total of 2, got: ${newer}`);
    assert.match(older, /,"1"(,|$)/, `expected the 2024-03-04 row to show a running total of 1, got: ${older}`);
  });

  await t.test('a member who actually scanned their badge never appears, even though they were assigned', async () => {
    const res = await request(app).get('/admin/logs?tab=missedduty').set('Cookie', cookie);
    assert.doesNotMatch(res.text, /Compliant Parent/);
  });

  await t.test('a no-show (no check-in, no absence form) appears flagged as No-Show', async () => {
    const csv = await request(app).get('/admin/logs/missedduty/export.csv').set('Cookie', cookie);
    const row = csv.text.split('\n').find((l) => l.includes('No Show Parent'));
    assert.ok(row, 'expected a CSV row for the no-show parent');
    assert.match(row, /"Yes"/, 'expected the No-Show This Date column to read Yes');
  });

  await t.test('a member who never checked in but DID submit an absence form is never flagged as a no-show', async () => {
    const csv = await request(app).get('/admin/logs/missedduty/export.csv').set('Cookie', cookie);
    assert.doesNotMatch(csv.text, /Excused Parent/);
  });

  await t.test('a member flagged for both reasons on the same date gets exactly one row with both counts set', async () => {
    const csv = await request(app).get('/admin/logs/missedduty/export.csv').set('Cookie', cookie);
    const rows = csv.text.split('\n').filter((l) => l.includes('Double Flag Parent'));
    assert.equal(rows.length, 1, 'expected exactly one merged row, not two separate ones');
    assert.match(rows[0], /"Yes","Yes"/, `expected both This-Date columns to read Yes on the merged row, got: ${rows[0]}`);
    assert.match(rows[0], /"1","1"$/, `expected both running totals to read 1 on this member's only appearance, got: ${rows[0]}`);
  });

  await t.test('the date filter narrows the log to just that date', async () => {
    const res = await request(app).get('/admin/logs?tab=missedduty&date=2024-03-04').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Missed Scan Parent/);
    assert.doesNotMatch(res.text, /2024-03-11/);
  });
});

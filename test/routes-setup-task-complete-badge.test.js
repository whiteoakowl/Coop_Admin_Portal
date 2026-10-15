// Real HTTP-level coverage for the Setup/Cleanup Assignments roster's
// "task(s) complete" badge (partials/setup-assignment-cards.ejs) - a real
// request: "when someone checks in or out with a setup/cleanup badge, on
// the setup/cleanup assignment page their name will be green, with a
// green check mark next to it saying task(s) complete and the task #
// they scanned." utils/setup.js's new scannedTasksForMemberDate reads the
// same real-scan-only columns (attendance.task_item_id/checkouts.
// task_item_id, never setup_task_assignments) utils/rosterGrid.js already
// uses for the Attendance page's own team/task column - merely being
// ASSIGNED a task on this same page must never trigger it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-task-complete-badge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-task-complete-badge-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { scannedTasksForMemberDate, setTaskAssignment } = require('../utils/setup');

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

test('utils/setup.js scannedTasksForMemberDate', async (t) => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Scan Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unit Scan Member', 'unit-scan-member', 'parent')")
    .run();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Scan Unit Team')").run();
  const { lastInsertRowid: sectionId } = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Scan Unit Tasks', ?, 0)")
    .run(teamId);
  const { lastInsertRowid: item1Id } = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)')
    .run(sectionId, 'Sweep floor');
  const { lastInsertRowid: item2Id } = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)')
    .run(sectionId, 'Empty trash');

  await t.test('no scan at all - empty', async () => {
    assert.deepEqual(await scannedTasksForMemberDate('2026-03-02'), {});
  });

  await t.test('a real scan at check-in (attendance.task_item_id + task_scanned_at) shows up', async () => {
    await db
      .prepare(
        `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source, task_item_id, task_scanned_at)
         VALUES (?, ?, '2026-03-02', 'present', ?, 'kiosk', ?, ?)`
      )
      .run(memberId, rosterId, Date.now(), item1Id, Date.now());
    const scanned = await scannedTasksForMemberDate('2026-03-02');
    assert.equal(scanned[memberId].length, 1);
    assert.equal(scanned[memberId][0].number, 1);
    assert.equal(scanned[memberId][0].teamName, 'Scan Unit Team');
  });

  await t.test('a second real scan at checkout (checkouts.task_item_id_2) shows up alongside it', async () => {
    await db
      .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, task_item_id_2, check_out_time) VALUES (?, ?, ?, ?, ?)')
      .run(memberId, rosterId, '2026-03-02', item2Id, Date.now());
    const scanned = await scannedTasksForMemberDate('2026-03-02');
    assert.equal(scanned[memberId].length, 2);
    const numbers = scanned[memberId].map((s) => s.number).sort();
    assert.deepEqual(numbers, [1, 2]);
  });

  await t.test('merely ASSIGNING a task (no scan) never shows up', async () => {
    const { lastInsertRowid: unscannedMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unit Assigned Only Member', 'unit-assigned-only', 'parent')")
      .run();
    await setTaskAssignment('monday', unscannedMemberId, '2026-03-02', 1, item1Id);
    const scanned = await scannedTasksForMemberDate('2026-03-02');
    assert.equal(scanned[unscannedMemberId], undefined, 'an assignment alone must never produce a scanned-task entry');
  });

  await t.test('an empty date returns nothing', async () => {
    assert.deepEqual(await scannedTasksForMemberDate(''), {});
  });
});

test('Setup/Cleanup Assignments: a real badge scan shows a green "Task(s) complete" badge with the task number, taking precedence over checked-out', async () => {
  const cookie = await loginAsAdmin();

  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Task Complete Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: scannedMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Scanned Badge Volunteer', 'scanned-badge-monday', 'scanned-badge-monday', 'parent')")
    .run();
  const { lastInsertRowid: assignedOnlyMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Assigned Only Volunteer', 'assigned-only-monday', 'assigned-only-monday', 'parent')")
    .run();

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Task Complete Team')").run();
  await db
    .prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?), (?, ?)')
    .run(teamId, scannedMemberId, teamId, assignedOnlyMemberId);
  await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run('monday', today);
  const { lastInsertRowid: sectionId } = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Task Complete Tasks', ?, 0)")
    .run(teamId);
  const { lastInsertRowid: taskItemId } = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)')
    .run(sectionId, 'Stack chairs');

  // scannedMemberId genuinely scanned their badge at check-in, then
  // checked out (checkouts row exists too) - "task(s) complete" (green)
  // must win over "checked out" (red).
  await db
    .prepare(
      `INSERT INTO attendance (member_id, roster_id, session_date, status, check_in_time, source, task_item_id, task_scanned_at)
       VALUES (?, ?, ?, 'present', ?, 'kiosk', ?, ?)`
    )
    .run(scannedMemberId, rosterId, today, Date.now(), taskItemId, Date.now());
  await db
    .prepare('INSERT INTO checkouts (member_id, roster_id, session_date, check_out_time) VALUES (?, ?, ?, ?)')
    .run(scannedMemberId, rosterId, today, Date.now());

  // assignedOnlyMemberId is merely picked on this page's own Assign
  // dropdown - no real scan at all.
  await setTaskAssignment('monday', assignedOnlyMemberId, today, 1, taskItemId);

  const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-checked-in">\s*<a class="member-name-link"[^>]*>Scanned Badge Volunteer<\/a>\s*<span class="setup-task-complete-badge">[\s\S]*?Task complete: Task Complete Team-#1/,
    'the member who really scanned a badge should show the green task-complete badge with their task number, not the checked-out red flag'
  );
  assert.doesNotMatch(
    res.text,
    /<tr>\s*<td class="floater-card-position setup-assignment-name-checked-out">\s*<a class="member-name-link"[^>]*>Scanned Badge Volunteer/,
    'task-complete must take precedence over checked-out'
  );
  assert.doesNotMatch(
    res.text,
    /Assigned Only Volunteer[\s\S]{0,80}setup-task-complete-badge/,
    'being merely assigned a task (never scanned) must never trigger the task-complete badge'
  );
});

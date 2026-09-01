// Real HTTP-level coverage for a feature request: "add a dropdown menu
// to each setup/cleanup team list that asks, log on check in or log on
// check out. choosing one or the other will determine when a member is
// asked to scan their setup/cleanup card... for example if team 1 is,
// log on check in, those members will click check in, scan their name
// tag, then will be asked to scan their setup/cleanup card. then if it
// is marked log on check out, check out requires members to scan name
// tag then scan setup/cleanup card. this still only works for parents,
// admin, primary parents etc. students are never asked to scan a setup/
// cleanup badge."
//
// setup_teams.task_scan_timing ('checkin'|'checkout', default 'checkout')
// drives utils/setup.js's memberScansTaskAtCheckin. routes/kiosk.js's
// /checkin/scan now conditionally routes a non-student to a second
// task-scan step (writing attendance.task_item_id/task_scanned_at -
// see the migration adding them); routes/checkout.js's /checkout/scan
// then skips its own task-scan step for anyone who already has
// task_scanned_at set for today, carrying the same task_item_id into
// the checkouts row it creates instead of asking again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-task-scan-timing-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-task-scan-timing-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

// Puts a member on Monday's own Parent roster for today (schedule_day
// really is 'monday', unlike a generic "any active roster" pick) - a
// team's own timing is scoped to a real day, so the test data needs to
// match it.
async function scheduleParentTodayOnMonday(memberId) {
  const roster = await db.prepare("SELECT id FROM rosters WHERE schedule_day = 'monday' AND name LIKE '%Parent%'").get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  return roster.id;
}

async function makeTeam(title, taskScanTiming) {
  return (await db.prepare('INSERT INTO setup_teams (day, title, task_scan_timing) VALUES (?, ?, ?)').run('monday', title, taskScanTiming)).lastInsertRowid;
}

async function addToTeam(teamId, memberId) {
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
}

async function makeTask(barcode) {
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Timing Test List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, 'Sweep Floor', barcode);
  return item.lastInsertRowid;
}

test('the admin team dropdown saves task_scan_timing', async (t) => {
  await t.test('creating a team defaults to "checkout" with no explicit choice', async () => {
    const { cookie, csrfToken } = await loginAsAdmin();
    await request(app)
      .post('/admin/setup/monday/teams')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Default Timing Team' });

    const team = await db.prepare("SELECT * FROM setup_teams WHERE title = 'Default Timing Team'").get();
    assert.equal(team.task_scan_timing, 'checkout');
  });

  await t.test('creating a team with "checkin" explicitly chosen saves that', async () => {
    const { cookie, csrfToken } = await loginAsAdmin();
    await request(app)
      .post('/admin/setup/monday/teams')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Checkin Timing Team', taskScanTiming: 'checkin' });

    const team = await db.prepare("SELECT * FROM setup_teams WHERE title = 'Checkin Timing Team'").get();
    assert.equal(team.task_scan_timing, 'checkin');
  });

  await t.test('editing an existing team can flip its timing from checkout to checkin', async () => {
    const { cookie, csrfToken } = await loginAsAdmin();
    const teamId = await makeTeam('Flip Timing Team', 'checkout');

    await request(app)
      .post(`/admin/setup/monday/teams/${teamId}/edit`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, title: 'Flip Timing Team', taskScanTiming: 'checkin' });

    const team = await db.prepare('SELECT * FROM setup_teams WHERE id = ?').get(teamId);
    assert.equal(team.task_scan_timing, 'checkin');
  });

  await t.test('the manage page dropdown reflects each team\'s own saved timing', async () => {
    const { cookie } = await loginAsAdmin();
    const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
    const teamHtml = /Checkin Timing Team[\s\S]*?<\/div>\s*<\/div>\s*<div class="team-members-card">/.exec(res.text)[0];
    assert.match(teamHtml, /<option value="checkin" selected>Log on check in<\/option>/);
  });
});

test('a member on a "log on check in" team scans their badge at check-in, and checkout skips asking again', async (t) => {
  await t.test('checking in routes to the task-scan step instead of finishing immediately', async () => {
    const teamId = await makeTeam('Checkin Flow Team', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkin Timing Parent', 'checkin-timing-parent-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    await scheduleParentTodayOnMonday(memberId);

    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'checkin-timing-parent-1' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'parent-taskscan');
    assert.equal(res.body.memberId, memberId);

    // Already marked present, even though the task step isn't done yet.
    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND session_date = ?').get(memberId, todayISO());
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.task_scanned_at, null, 'the task step has not happened yet');
  });

  await t.test('scanning the task badge at check-in records it on the attendance row, and checkout is then a single scan carrying the same task', async () => {
    const taskId = await makeTask('999101');
    const teamId = await makeTeam('Checkin Flow Team 2', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkin Task Parent', 'checkin-task-parent-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'checkin-task-parent-1' });
    const taskScanRes = await request(app)
      .post('/kiosk/checkin/task-scan')
      .type('form')
      .send({ memberId: String(memberId), barcode: '999101' });
    assert.equal(taskScanRes.body.ok, true);
    assert.match(taskScanRes.body.message, /Thank you for checking in, Checkin Task Parent!/);

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, taskId);
    assert.ok(attendance.task_scanned_at);

    // Checkout: a single scan, no second step, and the SAME task carries
    // over into the checkouts row.
    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'checkin-task-parent-1' });
    assert.equal(checkoutRes.body.ok, true);
    assert.equal(checkoutRes.body.memberType, 'parent-already-logged');
    assert.match(checkoutRes.body.message, /Thank you for checking out, Checkin Task Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'expected a checkout row even though the task step ran at check-in');
    assert.equal(checkout.task_item_id, taskId, 'the task logged at check-in should carry over into checkout, not be asked for again');
  });

  await t.test('the bypass badge works at check-in too, and still counts as "already logged" at checkout', async () => {
    const bypass = await db.prepare("SELECT barcode FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL").get();
    const teamId = await makeTeam('Checkin Bypass Team', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkin Bypass Parent', 'checkin-bypass-parent-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'checkin-bypass-parent-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: bypass.barcode });

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, null, 'a bypass scan has no specific task');
    assert.ok(attendance.task_scanned_at, 'but the check-in task step itself is still marked done');

    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'checkin-bypass-parent-1' });
    assert.equal(checkoutRes.body.memberType, 'parent-already-logged', 'a bypass scan at check-in must still skip the checkout ask');
  });
});

test('a member on a "log on check out" team (or no team at all) keeps the original single-step check-in / two-step checkout flow', async (t) => {
  await t.test('a member on an explicit "checkout" team checks in with one scan, and still gets asked at checkout', async () => {
    const teamId = await makeTeam('Checkout Flow Team', 'checkout');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkout Timing Parent', 'checkout-timing-parent-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    await scheduleParentTodayOnMonday(memberId);

    const checkinRes = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'checkout-timing-parent-1' });
    assert.equal(checkinRes.body.ok, true);
    assert.notEqual(checkinRes.body.memberType, 'parent-taskscan', 'a "checkout" team should not route to the check-in task-scan step');
    assert.match(checkinRes.body.message, /Thank you for checking in/);

    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'checkout-timing-parent-1' });
    assert.equal(checkoutRes.body.memberType, 'parent', 'still the original two-step flow - not yet checked out');
    assert.equal(checkoutRes.body.memberId, memberId);
  });

  await t.test('a member on no Setup/Cleanup team at all is completely unaffected', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Team Parent', 'no-team-parent-1', 'parent')")
      .run();
    await scheduleParentTodayOnMonday(memberId);

    const checkinRes = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'no-team-parent-1' });
    assert.match(checkinRes.body.message, /Thank you for checking in/);

    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'no-team-parent-1' });
    assert.equal(checkoutRes.body.memberType, 'parent');
  });
});

test('a student is never asked to scan a Setup/Cleanup badge, even if somehow placed on a "log on check in" team', async () => {
  const teamId = await makeTeam('Student Guard Team', 'checkin');
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Guard Student', 'guard-student-1', 'student')")
    .run();
  // Not something the real Add Member picker would ever offer (parents/
  // admins only) - inserted directly to prove the guard is a real
  // member_type check, not just "nobody happens to add a student here".
  await addToTeam(teamId, studentId);
  await scheduleParentTodayOnMonday(studentId);

  const checkinRes = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'guard-student-1' });
  assert.notEqual(checkinRes.body.memberType, 'parent-taskscan');
  assert.match(checkinRes.body.message, /Thank you for checking in/);

  const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'guard-student-1' });
  assert.equal(checkoutRes.body.memberType, 'student');
  assert.match(checkoutRes.body.message, /Thank you for checking out/);
});

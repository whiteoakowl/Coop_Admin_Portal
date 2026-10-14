// Real HTTP-level coverage for a real request: "For kiosk check out or in
// with setup/cleanup cards. Currently it asks if you did a 2nd job. Also,
// add asking if you did a 3rd job." Same shape as test/setup-cleanup-
// second-badge.test.js's own 2nd-badge coverage, one slot further -
// attendance.task_item_id_3/task_scanned_at_3 and checkouts.task_item_id_3
// hold the third scan (see the migration adding them). task-scan-2 now
// answers with needsThirdBadgeChoice: true (the client asks Yes/No before
// actually finishing); /checkin/task-scan-3 and /checkout/task-scan-3
// record the optional third scan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-third-badge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-third-badge-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

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

async function makeTask(barcode, description) {
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Third Badge Test List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, description || 'Sweep Floor', barcode);
  return item.lastInsertRowid;
}

test('check-in: task-scan-2 asks about a 3rd badge, and task-scan-3 records it in the third slot', async (t) => {
  await t.test('the second badge scan answers needsThirdBadgeChoice instead of finishing', async () => {
    const task1 = await makeTask('889101', 'Sweep Floor');
    const task2 = await makeTask('889102', 'Empty Trash');
    const teamId = await makeTeam('3rd Badge Checkin Team', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Third Badge Checkin Parent', 'third-badge-checkin-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'third-badge-checkin-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: '889101' });
    const res = await request(app)
      .post('/kiosk/checkin/task-scan-2')
      .type('form')
      .send({ memberId: String(memberId), barcode: '889102' });

    assert.equal(res.body.ok, true);
    assert.equal(res.body.needsThirdBadgeChoice, true);
    assert.match(res.body.message, /Thank you for checking in, Third Badge Checkin Parent!/);

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, task1);
    assert.equal(attendance.task_item_id_2, task2);
    assert.equal(attendance.task_item_id_3, null, 'no 3rd badge scanned yet');
    assert.equal(attendance.task_scanned_at_3, null);
  });

  await t.test('answering "Yes" and scanning a 3rd badge records it in the third slot', async () => {
    const task1 = await makeTask('889103', 'Sweep Floor');
    const task2 = await makeTask('889104', 'Empty Trash');
    const task3 = await makeTask('889105', 'Wipe Tables');
    const teamId = await makeTeam('3rd Badge Checkin Team 2', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Three Job Checkin Parent', 'three-job-checkin-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'three-job-checkin-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: '889103' });
    await request(app).post('/kiosk/checkin/task-scan-2').type('form').send({ memberId: String(memberId), barcode: '889104' });

    const thirdRes = await request(app)
      .post('/kiosk/checkin/task-scan-3')
      .type('form')
      .send({ memberId: String(memberId), barcode: '889105' });
    assert.equal(thirdRes.body.ok, true);
    assert.match(thirdRes.body.message, /Thank you for checking in, Three Job Checkin Parent!/);

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, task1);
    assert.equal(attendance.task_item_id_2, task2);
    assert.equal(attendance.task_item_id_3, task3);
    assert.ok(attendance.task_scanned_at_3);
  });

  await t.test('a 3rd badge already logged by someone else (in any slot) is rejected', async () => {
    await makeTask('889106', 'Shared Task');
    await makeTask('889107', 'Filler One');
    await makeTask('889108', 'Filler Two');
    const teamId = await makeTeam('3rd Badge Conflict Team', 'checkin');
    const { lastInsertRowid: firstMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Conflict Parent Three A', 'conflict-parent-three-a-1', 'parent')")
      .run();
    const { lastInsertRowid: secondMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Conflict Parent Three B', 'conflict-parent-three-b-1', 'parent')")
      .run();
    await addToTeam(teamId, firstMemberId);
    await addToTeam(teamId, secondMemberId);
    await scheduleParentTodayOnMonday(firstMemberId);
    await scheduleParentTodayOnMonday(secondMemberId);

    // First parent logs the shared task as their own 1st badge (slot 1).
    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'conflict-parent-three-a-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(firstMemberId), barcode: '889106' });
    // Second parent fills slots 1 and 2 with unrelated tasks, then tries
    // to claim the shared task as their slot 3 - must be blocked exactly
    // like a slot-1-vs-slot-1 conflict would be.
    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'conflict-parent-three-b-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(secondMemberId), barcode: '889107' });
    await request(app).post('/kiosk/checkin/task-scan-2').type('form').send({ memberId: String(secondMemberId), barcode: '889108' });

    const blockedRes = await request(app)
      .post('/kiosk/checkin/task-scan-3')
      .type('form')
      .send({ memberId: String(secondMemberId), barcode: '889106' });
    assert.match(blockedRes.body.message, /already been logged today/);
  });
});

test('check-out: task-scan-2 asks about a 3rd badge, and task-scan-3 updates the same checkouts row', async (t) => {
  await t.test('the second badge scan answers needsThirdBadgeChoice instead of finishing, and the checkouts row already exists', async () => {
    const task1 = await makeTask('889201', 'Vacuum');
    const task2 = await makeTask('889202', 'Mop Floor');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Third Badge Checkout Parent', 'third-badge-checkout-1', 'parent')")
      .run();
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'third-badge-checkout-1' });
    await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '889201' });
    const res = await request(app)
      .post('/kiosk/checkout/task-scan-2')
      .type('form')
      .send({ memberId: String(memberId), barcode: '889202' });

    assert.equal(res.body.ok, true);
    assert.equal(res.body.needsThirdBadgeChoice, true);
    assert.match(res.body.message, /Thank you for checking out, Third Badge Checkout Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'the checkout row already exists from the first badge scan');
    assert.equal(checkout.task_item_id, task1);
    assert.equal(checkout.task_item_id_2, task2);
    assert.equal(checkout.task_item_id_3, null);
  });

  await t.test('answering "Yes" and scanning a 3rd badge updates task_item_id_3 on the same row', async () => {
    const task1 = await makeTask('889203', 'Vacuum');
    const task2 = await makeTask('889204', 'Mop Floor');
    const task3 = await makeTask('889205', 'Take Out Recycling');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Three Job Checkout Parent', 'three-job-checkout-1', 'parent')")
      .run();
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'three-job-checkout-1' });
    await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '889203' });
    await request(app).post('/kiosk/checkout/task-scan-2').type('form').send({ memberId: String(memberId), barcode: '889204' });

    const thirdRes = await request(app)
      .post('/kiosk/checkout/task-scan-3')
      .type('form')
      .send({ memberId: String(memberId), barcode: '889205' });
    assert.equal(thirdRes.body.ok, true);
    assert.match(thirdRes.body.message, /Thank you for checking out, Three Job Checkout Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(checkout.task_item_id, task1);
    assert.equal(checkout.task_item_id_2, task2);
    assert.equal(checkout.task_item_id_3, task3);
  });

  await t.test('a member already logged at check-in with a 3rd badge carries all three slots into checkout automatically', async () => {
    const task1 = await makeTask('889206', 'Sweep Floor');
    const task2 = await makeTask('889207', 'Empty Trash');
    const task3 = await makeTask('889208', 'Wipe Tables');
    const teamId = await makeTeam('Carry Over Team Three', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Carry Over Parent Three', 'carry-over-parent-three-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'carry-over-parent-three-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: '889206' });
    await request(app).post('/kiosk/checkin/task-scan-2').type('form').send({ memberId: String(memberId), barcode: '889207' });
    await request(app).post('/kiosk/checkin/task-scan-3').type('form').send({ memberId: String(memberId), barcode: '889208' });

    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'carry-over-parent-three-1' });
    assert.equal(checkoutRes.body.memberType, 'parent-already-logged');

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(checkout.task_item_id, task1);
    assert.equal(checkout.task_item_id_2, task2);
    assert.equal(checkout.task_item_id_3, task3, 'the 3rd badge logged at check-in should carry over into checkout too');
  });
});

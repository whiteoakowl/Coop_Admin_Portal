// Real HTTP-level coverage for a feature request: "check in/out. after
// parent scans their setup/cleanup badge it should ask if they have a
// 2nd setup/cleanup badge to scan, with yes and no buttons. if they
// select yes, it allows them to scan their barcode. if they are
// entering I'd numbers, it will show a keypad and allow them to enter
// their ID number. after the 2nd badge entry the screen says thank,
// you! and goes back to the home screen. if they select no, it's says
// thank you! and goes back to the home screen."
//
// A parent can cover two Setup/Cleanup jobs the same day (mirrors
// setup_task_assignments.task_item_id_2's own existing "a member
// routinely covers two jobs at once" case) - attendance.task_item_id_2/
// task_scanned_at_2 and checkouts.task_item_id_2 hold the second scan
// (see the migration adding them). Both /checkin/task-scan and
// /checkout/task-scan now answer with needsSecondBadgeChoice: true (the
// client - public/js/kiosk-checkin.js/kiosk-checkout.js - asks Yes/No
// before actually finishing); /checkin/task-scan-2 and
// /checkout/task-scan-2 record the optional second scan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-second-badge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-second-badge-test-uploads-${process.pid}`);
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
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Second Badge Test List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, description || 'Sweep Floor', barcode);
  return item.lastInsertRowid;
}

test('check-in: task-scan asks about a 2nd badge, and task-scan-2 records it in the second slot', async (t) => {
  await t.test('the first badge scan answers needsSecondBadgeChoice instead of finishing', async () => {
    const taskId = await makeTask('888101', 'Sweep Floor');
    const teamId = await makeTeam('2nd Badge Checkin Team', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Second Badge Checkin Parent', 'second-badge-checkin-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'second-badge-checkin-1' });
    const res = await request(app)
      .post('/kiosk/checkin/task-scan')
      .type('form')
      .send({ memberId: String(memberId), barcode: '888101' });

    assert.equal(res.body.ok, true);
    assert.equal(res.body.needsSecondBadgeChoice, true);
    assert.match(res.body.message, /Thank you for checking in, Second Badge Checkin Parent!/);

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, taskId);
    assert.ok(attendance.task_scanned_at);
    assert.equal(attendance.task_item_id_2, null, 'no 2nd badge scanned yet');
    assert.equal(attendance.task_scanned_at_2, null);
  });

  await t.test('answering "Yes" and scanning a 2nd badge records it in the second slot', async () => {
    const task1 = await makeTask('888102', 'Sweep Floor');
    const task2 = await makeTask('888103', 'Empty Trash');
    const teamId = await makeTeam('2nd Badge Checkin Team 2', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Two Job Checkin Parent', 'two-job-checkin-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'two-job-checkin-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: '888102' });

    const secondRes = await request(app)
      .post('/kiosk/checkin/task-scan-2')
      .type('form')
      .send({ memberId: String(memberId), barcode: '888103' });
    assert.equal(secondRes.body.ok, true);
    assert.match(secondRes.body.message, /Thank you for checking in, Two Job Checkin Parent!/);

    const attendance = await db.prepare('SELECT * FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(attendance.task_item_id, task1);
    assert.equal(attendance.task_item_id_2, task2);
    assert.ok(attendance.task_scanned_at_2);
  });

  await t.test('a 2nd badge already logged by someone else is rejected, same as the 1st-slot check', async () => {
    await makeTask('888104', 'Shared Task');
    await makeTask('888105', 'Filler Task');
    const teamId = await makeTeam('2nd Badge Conflict Team', 'checkin');
    const { lastInsertRowid: firstMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Conflict Parent One', 'conflict-parent-one-1', 'parent')")
      .run();
    const { lastInsertRowid: secondMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Conflict Parent Two', 'conflict-parent-two-1', 'parent')")
      .run();
    await addToTeam(teamId, firstMemberId);
    await addToTeam(teamId, secondMemberId);
    await scheduleParentTodayOnMonday(firstMemberId);
    await scheduleParentTodayOnMonday(secondMemberId);

    // First parent logs the shared task as their own 1st badge (slot 1).
    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'conflict-parent-one-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(firstMemberId), barcode: '888104' });
    // Second parent logs an unrelated task as their own slot 1, then tries
    // to claim the same shared task as their slot 2 - must be blocked
    // exactly like a slot-1-vs-slot-1 conflict would be.
    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'conflict-parent-two-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(secondMemberId), barcode: '888105' });

    const blockedRes = await request(app)
      .post('/kiosk/checkin/task-scan-2')
      .type('form')
      .send({ memberId: String(secondMemberId), barcode: '888104' });
    assert.match(blockedRes.body.message, /already been logged today/);
  });
});

test('check-out: task-scan asks about a 2nd badge, and task-scan-2 updates the same checkouts row', async (t) => {
  await t.test('the first badge scan answers needsSecondBadgeChoice instead of finishing, and the checkouts row already exists', async () => {
    const taskId = await makeTask('888201', 'Vacuum');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Second Badge Checkout Parent', 'second-badge-checkout-1', 'parent')")
      .run();
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'second-badge-checkout-1' });
    const res = await request(app)
      .post('/kiosk/checkout/task-scan')
      .type('form')
      .send({ memberId: String(memberId), barcode: '888201' });

    assert.equal(res.body.ok, true);
    assert.equal(res.body.needsSecondBadgeChoice, true);
    assert.match(res.body.message, /Thank you for checking out, Second Badge Checkout Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'the checkout row is already created by the first badge scan');
    assert.equal(checkout.task_item_id, taskId);
    assert.equal(checkout.task_item_id_2, null);
  });

  await t.test('answering "Yes" and scanning a 2nd badge updates task_item_id_2 on the same row', async () => {
    const task1 = await makeTask('888202', 'Vacuum');
    const task2 = await makeTask('888203', 'Take Out Recycling');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Two Job Checkout Parent', 'two-job-checkout-1', 'parent')")
      .run();
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'two-job-checkout-1' });
    await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '888202' });

    const secondRes = await request(app)
      .post('/kiosk/checkout/task-scan-2')
      .type('form')
      .send({ memberId: String(memberId), barcode: '888203' });
    assert.equal(secondRes.body.ok, true);
    assert.match(secondRes.body.message, /Thank you for checking out, Two Job Checkout Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(checkout.task_item_id, task1);
    assert.equal(checkout.task_item_id_2, task2);
  });

  await t.test('a member already logged at check-in with a 2nd badge carries both slots into checkout automatically', async () => {
    const task1 = await makeTask('888204', 'Sweep Floor');
    const task2 = await makeTask('888205', 'Empty Trash');
    const teamId = await makeTeam('Carry Over Team', 'checkin');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Carry Over Parent', 'carry-over-parent-1', 'parent')")
      .run();
    await addToTeam(teamId, memberId);
    const rosterId = await scheduleParentTodayOnMonday(memberId);

    await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'carry-over-parent-1' });
    await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(memberId), barcode: '888204' });
    await request(app).post('/kiosk/checkin/task-scan-2').type('form').send({ memberId: String(memberId), barcode: '888205' });

    const checkoutRes = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'carry-over-parent-1' });
    assert.equal(checkoutRes.body.memberType, 'parent-already-logged');

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.equal(checkout.task_item_id, task1);
    assert.equal(checkout.task_item_id_2, task2, 'the 2nd badge logged at check-in should carry over into checkout too, not just the 1st');
  });
});

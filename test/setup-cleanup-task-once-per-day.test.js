// Real HTTP-level coverage for a feature request: "don't allow each
// setup/cleanup badge to be scanned more than once in a day."
// utils/taskList.js's taskAlreadyLoggedByAnotherMember is checked at
// both scan points - routes/checkout.js's /checkout/task-scan and
// routes/kiosk.js's /checkin/task-scan (a real task can be logged at
// either, depending on the scanning member's own team's
// task_scan_timing - see test/setup-cleanup-task-scan-timing.test.js) -
// so the same physical task can't be credited to two different people
// the same day, whichever order/screen they scan on. The scanning
// member's own already-recorded pick never blocks THEMSELVES (re-
// scanning to correct your own choice, per the pre-existing "most
// recent scan wins" test in test/routes-checkout.test.js). The general
// bypass badge is deliberately exempt - it's meant to be reused by
// anyone without their own card, any number of times a day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-task-once-per-day-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-task-once-per-day-test-uploads-${process.pid}`);
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

async function scheduleMemberToday(memberId) {
  const roster = await db.prepare("SELECT id FROM rosters WHERE schedule_day = 'monday' AND name LIKE '%Parent%'").get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  return roster.id;
}

async function makeTask(description, barcode) {
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Once Per Day List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, description, barcode);
  return item.lastInsertRowid;
}

async function makeParent(name, barcode) {
  return (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'parent')").run(name, barcode)).lastInsertRowid;
}

test('a task badge already logged by one checkout parent is rejected for a different parent, at checkout', async () => {
  const taskId = await makeTask('Wipe Tables', '777001');

  const firstId = await makeParent('First Wipe Parent', 'first-wipe-parent-1');
  await scheduleMemberToday(firstId);
  const firstRes = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(firstId), barcode: '777001' });
  assert.equal(firstRes.body.ok, true);

  const secondId = await makeParent('Second Wipe Parent', 'second-wipe-parent-1');
  await scheduleMemberToday(secondId);
  const secondRes = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(secondId), barcode: '777001' });
  assert.equal(secondRes.body.ok, false);
  assert.match(secondRes.body.message, /already been logged today/);

  const secondCheckout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ?').get(secondId);
  assert.equal(secondCheckout, undefined, 'the second parent must not have been checked out at all');
  assert.equal(taskId, (await db.prepare("SELECT id FROM task_list_items WHERE barcode = '777001'").get()).id);
});

test('the SAME parent re-scanning their own already-logged task is still allowed (correcting yourself)', async () => {
  await makeTask('Stack Chairs', '777002');
  const memberId = await makeParent('Self Correct Parent', 'self-correct-parent-1');
  await scheduleMemberToday(memberId);

  const first = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '777002' });
  assert.equal(first.body.ok, true);
  const second = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '777002' });
  assert.equal(second.body.ok, true, 'the same member scanning their own pick again must not be rejected as a duplicate');
});

test('a task logged at CHECK-IN blocks a different parent from claiming it at CHECKOUT, and vice versa', async () => {
  const teamId = (await db.prepare("INSERT INTO setup_teams (day, title, task_scan_timing) VALUES ('monday', 'Cross-Step Team', 'checkin')").run()).lastInsertRowid;
  const taskId = await makeTask('Take Out Trash', '777003');

  const checkinMemberId = await makeParent('Checkin Claimer', 'checkin-claimer-1');
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, checkinMemberId);
  await scheduleMemberToday(checkinMemberId);

  await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'checkin-claimer-1' });
  const checkinTaskRes = await request(app).post('/kiosk/checkin/task-scan').type('form').send({ memberId: String(checkinMemberId), barcode: '777003' });
  assert.equal(checkinTaskRes.body.ok, true);

  // A different parent (not on a "checkin" team - the ordinary flow)
  // tries to claim the SAME task at checkout - must be rejected, even
  // though it was logged on the check-in path, not checkout's own.
  const checkoutMemberId = await makeParent('Checkout Claimer', 'checkout-claimer-1');
  await scheduleMemberToday(checkoutMemberId);
  const blockedRes = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(checkoutMemberId), barcode: '777003' });
  assert.equal(blockedRes.body.ok, false);
  assert.match(blockedRes.body.message, /already been logged today/);

  const taskStillOnlyForFirst = await db.prepare('SELECT member_id FROM attendance WHERE task_item_id = ? AND session_date = ?').get(taskId, todayISO());
  assert.equal(taskStillOnlyForFirst.member_id, checkinMemberId);
});

test('the general bypass badge can be scanned by many different parents the same day without triggering the restriction', async () => {
  const bypass = await db.prepare("SELECT barcode FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL").get();

  const firstId = await makeParent('Bypass User One', 'bypass-user-one-1');
  await scheduleMemberToday(firstId);
  const firstRes = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(firstId), barcode: bypass.barcode });
  assert.equal(firstRes.body.ok, true);

  const secondId = await makeParent('Bypass User Two', 'bypass-user-two-1');
  await scheduleMemberToday(secondId);
  const secondRes = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(secondId), barcode: bypass.barcode });
  assert.equal(secondRes.body.ok, true, 'the bypass badge is meant to be reused by anyone without their own card - it must never be "already logged" for someone else');
});

test('a different task is still scannable by a different parent even after one task barcode is used up for the day', async () => {
  await makeTask('Used Up Task', '777004');
  const otherTaskId = await makeTask('Still Available Task', '777005');

  const firstId = await makeParent('Used Task Parent', 'used-task-parent-1');
  await scheduleMemberToday(firstId);
  await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(firstId), barcode: '777004' });

  const secondId = await makeParent('Available Task Parent', 'available-task-parent-1');
  const rosterId = await scheduleMemberToday(secondId);
  const res = await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(secondId), barcode: '777005' });
  assert.equal(res.body.ok, true, 'a different, not-yet-used task must still be claimable');

  const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ?').get(secondId, rosterId);
  assert.equal(checkout.task_item_id, otherTaskId);
});

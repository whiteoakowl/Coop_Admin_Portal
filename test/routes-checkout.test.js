// Real HTTP-level coverage for the checkout kiosk (routes/checkout.js) -
// rewritten this session to replace the old "choose a pickup number 1-80"
// step with: students check out on a single name tag scan, parents scan
// their name tag then the Setup/Cleanup badge for the task they completed.
// Same boot pattern as test/routes-kiosk-checkin.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-checkout-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-checkout-test-uploads-${process.pid}`);
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
  const roster = await db.prepare('SELECT id FROM rosters WHERE active = 1 LIMIT 1').get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  return roster.id;
}

async function makeTask(barcode) {
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Checkout Test List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, 'Snack Table', barcode);
  return item.lastInsertRowid;
}

// A real request: "only members added to setup/cleanup teams will be
// asked for a setup/cleanup badge scan" - routes/checkout.js's own
// /checkout/scan only asks for the task-scan step when the member is an
// actual (non-leader) member of a 'checkout'-timing Setup/Cleanup team,
// not just any parent (see utils/setup.js's memberNeedsSetupBadgeAtCheckout).
async function addToCheckoutTeam(memberId) {
  const team = await db.prepare("INSERT INTO setup_teams (day, title, task_scan_timing) VALUES ('monday', 'Checkout Test Team', 'checkout')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, memberId);
  return team.lastInsertRowid;
}

test('checkout kiosk - students', async (t) => {
  await t.test('an unrecognized barcode is rejected without creating a checkout row', async () => {
    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'NoSuchMember' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not recognized/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts').get()).n), 0);
  });

  await t.test('a member not scheduled on any roster today is rejected', async () => {
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Unscheduled Kid', 'Unscheduled Kid', 'student')").run();
    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'Unscheduled Kid' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not scheduled for a roster today/);
  });

  await t.test('a student checks out on a single scan - no number, no task barcode', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkout Kid', 'Checkout Kid', 'student')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);

    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'Checkout Kid' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'student');
    assert.match(res.body.message, /Thank you for checking out, Checkout Kid! Have a great day!/);

    const checkout = await db
      .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'expected a checkout row to have been written');
    assert.equal(checkout.number, null);
    assert.equal(checkout.task_item_id, null);
  });
});

test('checkout kiosk - parents', async (t) => {
  await t.test('scanning a parent on a Setup/Cleanup team moves to the task-scan step instead of checking out immediately', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Checkout Parent', 'Checkout Parent', 'parent')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);
    await addToCheckoutTeam(memberId);

    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'Checkout Parent' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'parent');
    assert.equal(res.body.memberId, memberId);

    // No checkout row yet - the parent hasn't scanned their task barcode.
    assert.equal(
      Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO())).n),
      0
    );
  });

  await t.test('a real request: "only members added to setup/cleanup teams will be asked for a setup/cleanup badge scan" - a parent on no team at all checks out immediately, no task-scan step', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Team Parent', 'No Team Parent', 'parent')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);

    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'No Team Parent' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'parent-no-badge');
    assert.match(res.body.message, /Thank you for checking out, No Team Parent! Have a great day!/);

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'expected a checkout row to have been written immediately');
    assert.equal(checkout.task_item_id, null);
  });

  await t.test('a real request: "if a member is a leader of a setup/cleanup team, they will not be asked for a setup/cleanup badge" - a team leader who is not a rank-and-file member checks out immediately', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Leader Only Parent', 'Leader Only Parent', 'parent')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);
    await db.prepare("INSERT INTO setup_teams (day, title, task_scan_timing, leader_id) VALUES ('monday', 'Leader Only Team', 'checkout', ?)").run(memberId);

    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'Leader Only Parent' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'parent-no-badge');

    const checkout = await db.prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, todayISO());
    assert.ok(checkout, 'expected a checkout row to have been written immediately');
  });

  await t.test('a team leader who is ALSO added as a rank-and-file member of that same team is still exempt', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Leader And Member Parent', 'Leader And Member Parent', 'parent')")
      .run();
    await scheduleMemberToday(memberId);
    const teamId = await addToCheckoutTeam(memberId);
    await db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(memberId, teamId);

    const res = await request(app).post('/kiosk/checkout/scan').type('form').send({ barcode: 'Leader And Member Parent' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.memberType, 'parent-no-badge');
  });

  await t.test('an unrecognized task barcode is rejected without checking the parent out', async () => {
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Task Reject Parent', 'Task Reject Parent', 'parent')")
      .run();
    await scheduleMemberToday(memberId);

    const res = await request(app)
      .post('/kiosk/checkout/task-scan')
      .type('form')
      .send({ memberId: String(memberId), barcode: 'NoSuchTask' });
    assert.equal(res.body.ok, false);
    assert.match(res.body.message, /not recognized/);
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM checkouts WHERE member_id = ?').get(memberId)).n), 0);
  });

  await t.test('scanning a recognized task barcode checks the parent out and records the task', async () => {
    const taskId = await makeTask('999001');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Task Scan Parent', 'Task Scan Parent', 'parent')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);

    const res = await request(app)
      .post('/kiosk/checkout/task-scan')
      .type('form')
      .send({ memberId: String(memberId), barcode: '999001' });
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /Thank you for checking out, Task Scan Parent! Have a great day!/);

    const checkout = await db
      .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, rosterId, todayISO());
    assert.ok(checkout);
    assert.equal(checkout.number, null);
    assert.equal(checkout.task_item_id, taskId);
  });

  await t.test('checking out again the same day updates which task was scanned instead of erroring', async () => {
    const taskA = await makeTask('999002');
    const taskB = await makeTask('999003');
    const { lastInsertRowid: memberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Repeat Parent', 'Repeat Parent', 'parent')")
      .run();
    const rosterId = await scheduleMemberToday(memberId);

    await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '999002' });
    await request(app).post('/kiosk/checkout/task-scan').type('form').send({ memberId: String(memberId), barcode: '999003' });

    const checkout = await db
      .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
      .get(memberId, rosterId, todayISO());
    assert.equal(checkout.task_item_id, taskB, 'the most recent scan should win');
    assert.notEqual(taskA, taskB);
  });
});

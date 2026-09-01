// A real request: "make an admin setup/cleanup card with a barcode. if
// someone doesn't have a setup cleanup card to scan the admin setup/
// cleanup card can be scanned to bypass the checkout demand for a
// setup/cleanup card. this will be available in bulk printing. this
// card isn't linked to any specific member. its just a general bypass
// card." Covers the seeding (db/bootstrapPg.js's seedIfMissing), the
// checkout-time fallback (routes/checkout.js's task-scan step, via
// utils/taskList.js's findSetupCleanupBypassBadge), and that it shows up
// in Design > Print > Setup/Cleanup Badges (routes/admin-misc-badges.js)
// alongside every real task's own badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-bypass-badge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-bypass-badge-test-uploads-${process.pid}`);
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

async function getBypassBadge() {
  return db.prepare("SELECT * FROM misc_badges WHERE badge_type = 'setupCleanup' AND task_item_id IS NULL").get();
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function scheduleMemberToday(memberId) {
  const roster = await db.prepare('SELECT id FROM rosters WHERE active = 1 LIMIT 1').get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);
  return roster.id;
}

test('a general Setup/Cleanup bypass badge is seeded automatically, with a real barcode and no member/task link', async () => {
  const badge = await getBypassBadge();
  assert.ok(badge, 'expected exactly one badge_type=setupCleanup row with no task_item_id');
  assert.ok(badge.barcode, 'should have a real generated barcode');
  assert.equal(badge.task_item_id, null, 'not tied to any specific task');
  assert.match(badge.title, /Bypass/i);
});

test('the bypass badge shows up in Design > Print > Setup/Cleanup Badges, right alongside real task badges', async () => {
  const { cookie } = await loginAsAdmin();
  const badge = await getBypassBadge();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`name="badgeIds" value="${badge.id}"`));
  assert.match(res.text, /Setup\/Cleanup Bypass Card/);
});

test('printing it renders like any other Setup/Cleanup badge, with its own real barcode value', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const badge = await getBypassBadge();

  const res = await request(app)
    .post('/admin/design/badges/setupCleanup/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ badgeIds: String(badge.id), _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`data-barcode-value="${badge.barcode}"`));
});

test('checkout: scanning the bypass badge instead of a task barcode still checks a parent out, with no specific task recorded', async () => {
  const badge = await getBypassBadge();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bypass Card Parent', 'Bypass Card Parent', 'parent')")
    .run();
  const rosterId = await scheduleMemberToday(memberId);

  const res = await request(app)
    .post('/kiosk/checkout/task-scan')
    .type('form')
    .send({ memberId: String(memberId), barcode: badge.barcode });
  assert.equal(res.body.ok, true);
  assert.match(res.body.message, /Thank you for checking out, Bypass Card Parent! Have a great day!/);

  const checkout = await db
    .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(memberId, rosterId, todayISO());
  assert.ok(checkout, 'expected a checkout row to have been written');
  assert.equal(checkout.task_item_id, null, 'a bypass scan is not tied to any specific task, same as an unmatched scan would leave it');
});

test('checkout: a real task barcode still takes priority - the bypass badge is only a fallback, not a shortcut that overrides a real scan', async () => {
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, position) VALUES ('monday', 'Bypass Priority Test List', 0)").run();
  const item = await db
    .prepare('INSERT INTO task_list_items (section_id, description, position, barcode) VALUES (?, ?, 0, ?)')
    .run(section.lastInsertRowid, 'Real Task', '888001');

  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Real Task Parent', 'Real Task Parent', 'parent')")
    .run();
  const rosterId = await scheduleMemberToday(memberId);

  const res = await request(app)
    .post('/kiosk/checkout/task-scan')
    .type('form')
    .send({ memberId: String(memberId), barcode: '888001' });
  assert.equal(res.body.ok, true);

  const checkout = await db
    .prepare('SELECT * FROM checkouts WHERE member_id = ? AND roster_id = ? AND session_date = ?')
    .get(memberId, rosterId, todayISO());
  assert.equal(checkout.task_item_id, item.lastInsertRowid, 'a real task barcode should still record that specific task, not fall through to the bypass path');
});

test('checkout: a genuinely unrecognized barcode is still rejected - the bypass fallback does not turn every scan into a pass', async () => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Still Rejected Parent', 'Still Rejected Parent', 'parent')")
    .run();
  await scheduleMemberToday(memberId);

  const res = await request(app)
    .post('/kiosk/checkout/task-scan')
    .type('form')
    .send({ memberId: String(memberId), barcode: 'TotallyMadeUpBarcode' });
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /not recognized/);
});

// Coverage for a real request: "Quicklinks have been created for member
// to quickly view setup/cleanup team, floater assignments, absence/late
// form, name tag form. When they go to these quick links they should be
// stand alone pages not connected to the kiosk. Member should not be
// able to access the kiosk by going to these pages."
//
// /setup, /volunteers, /absence, and /name-tag are the exact same bare
// URLs the Kiosk home screen's own links (views/kiosk-home.ejs) AND the
// admin-curated Quick Links (views/admin-settings.ejs, views/main-admin-
// quick-links.ejs) both point at - with nothing to tell those two
// visitors apart before this, every one of these pages always showed a
// "Return to Home Screen" link back into the real, interactive Kiosk
// (plus, for setup/volunteers, an idle timer that auto-navigated there
// too, and for absence/name-tag, a post-submit auto-redirect there).
// kiosk-home.ejs's own links now tag themselves with ?kiosk=1
// (routes/setup.js's/routes/volunteers.js's/routes/absence.js's/
// routes/name-tag.js's own isFromKiosk reads it) - every other way of
// reaching these 4 URLs (a Quick Link, a QR code, a bookmark) gets a
// fully standalone page with no path back into /kiosk at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `quick-links-kiosk-isolation-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `quick-links-kiosk-isolation-test-uploads-${process.pid}`);
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

test('kiosk-home.ejs tags its own Setup/Cleanup and Floater Assignments links with ?kiosk=1', async () => {
  const res = await request(app).get('/kiosk');
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/setup\?kiosk=1"/);
  assert.match(res.text, /href="\/volunteers\?kiosk=1"/);
});

test('the admin-curated Quick Links panels still use the bare URLs (no ?kiosk=1) - they are the standalone entry point', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const res = await request(app).get('/admin/settings?tab=quicklinks').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/setup" target="_blank"/);
  assert.match(res.text, /href="\/volunteers" target="_blank"/);
  assert.match(res.text, /href="\/absence" target="_blank"/);
  assert.match(res.text, /href="\/name-tag" target="_blank"/);
});

test('GET /setup: bare visit is standalone (no Home link, day links carry no ?kiosk=1); ?kiosk=1 visit keeps the kiosk Home link and chains it onto the day links', async () => {
  const bare = await request(app).get('/setup');
  assert.equal(bare.status, 200);
  assert.doesNotMatch(bare.text, /kiosk-home-inline/, 'a bare Quick Link visit should show no Home link at all');
  assert.doesNotMatch(bare.text, /href="\/kiosk"/);
  const dayMatch = /href="\/setup\/monday([^"]*)"/.exec(bare.text);
  assert.ok(dayMatch, 'expected a Monday day-picker link');
  assert.equal(dayMatch[1], '', 'a bare visit\'s own day links should not pick up ?kiosk=1 on their own');

  const fromKiosk = await request(app).get('/setup?kiosk=1');
  assert.equal(fromKiosk.status, 200);
  assert.match(fromKiosk.text, /class="kiosk-inline-header"/);
  assert.match(fromKiosk.text, /href="\/kiosk" class="kiosk-home kiosk-home-inline"/);
  assert.match(fromKiosk.text, /href="\/setup\/monday\?kiosk=1"/, 'the kiosk context should carry through onto the next step');
});

test('GET /setup/:day: bare visit has no Return to Home Screen link and no idle-redirect; ?kiosk=1 visit has both', async () => {
  const bare = await request(app).get('/setup/monday');
  assert.equal(bare.status, 200);
  assert.doesNotMatch(bare.text, /Return to Home Screen/);
  assert.doesNotMatch(bare.text, /href="\/kiosk"/);
  assert.doesNotMatch(bare.text, /data-idle-redirect=/, 'a Quick Link visit should never auto-navigate anywhere on idle');

  const fromKiosk = await request(app).get('/setup/monday?kiosk=1');
  assert.equal(fromKiosk.status, 200);
  assert.match(fromKiosk.text, /Return to Home Screen/);
  assert.match(fromKiosk.text, /href="\/kiosk"/);
  assert.match(fromKiosk.text, /data-idle-redirect="20000"/);
});

test('GET /volunteers and /volunteers/:day: same bare-vs-?kiosk=1 split as /setup', async () => {
  const bareDay = await request(app).get('/volunteers');
  assert.equal(bareDay.status, 200);
  assert.doesNotMatch(bareDay.text, /href="\/kiosk"/);

  const kioskDay = await request(app).get('/volunteers?kiosk=1');
  assert.equal(kioskDay.status, 200);
  assert.match(kioskDay.text, /href="\/kiosk" class="kiosk-home kiosk-home-inline"/);
  assert.match(kioskDay.text, /href="\/volunteers\/monday\?kiosk=1"/);

  const bareChart = await request(app).get('/volunteers/monday');
  assert.equal(bareChart.status, 200);
  assert.doesNotMatch(bareChart.text, /Return to Home Screen/);
  assert.doesNotMatch(bareChart.text, /href="\/kiosk"/);
  assert.doesNotMatch(bareChart.text, /data-idle-redirect=/);

  const kioskChart = await request(app).get('/volunteers/monday?kiosk=1');
  assert.equal(kioskChart.status, 200);
  assert.match(kioskChart.text, /Return to Home Screen/);
  assert.match(kioskChart.text, /href="\/kiosk"/);
  assert.match(kioskChart.text, /data-idle-redirect="20000"/);
});

// A real request: after a successful submission, both forms used to
// auto-navigate the visitor to /kiosk a few seconds later
// (public/js/absence.js's/public/js/name-tag.js's own window.
// fullscreenNavigate('/kiosk')) - fine for the physical kiosk screen
// cycling back for the next person, but for a Quick Link visitor on
// their own device this was a second, less obvious way to land them on
// the real, interactive Kiosk home screen. Both routes still set
// result.redirectHome: true on success either way; only the rendered
// data-redirect-home attribute (what the client script actually checks)
// is gated on fromKiosk now.
test('POST /absence/submit success: data-redirect-home only renders when fromKiosk', async () => {
  const today = todayISO();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Quick Link Absence Parent', 'quicklink-absence-parent', 'parent')")
    .run();
  const { lastInsertRowid: rosterId } = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Quick Link Absence Roster', 'Parent', 'monday')")
    .run();
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, parentId);
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);

  const bareSubmit = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({ type: 'absence', parentId: String(parentId), studentIds: [String(parentId)], sessionDate: today, reasonCategory: 'personal', reason: 'Quick Link test' });
  assert.equal(bareSubmit.status, 200);
  assert.doesNotMatch(bareSubmit.text, /data-redirect-home="1"/, 'a standalone Quick Link submission should not auto-navigate anywhere');

  const kioskSubmit = await request(app)
    .post('/absence/submit?kiosk=1')
    .type('form')
    .send({ type: 'absence', parentId: String(parentId), studentIds: [String(parentId)], sessionDate: today, reasonCategory: 'medical', reason: 'Kiosk test' });
  assert.equal(kioskSubmit.status, 200);
  assert.match(kioskSubmit.text, /data-redirect-home="1"/, 'a real kiosk submission should still auto-navigate home');
});

test('POST /name-tag/submit success: data-redirect-home only renders when fromKiosk', async () => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Quick Link Tag Member', 'quicklink-tag-member', 'parent', 1)")
    .run();

  const bareSubmit = await request(app)
    .post('/name-tag/submit')
    .type('form')
    .send({ memberId: String(memberId), memberIds: [String(memberId)], requestType: 'lost_tag', day: 'both', description: 'Quick Link test' });
  assert.equal(bareSubmit.status, 200);
  assert.doesNotMatch(bareSubmit.text, /data-redirect-home="1"/, 'a standalone Quick Link submission should not auto-navigate anywhere');

  const kioskSubmit = await request(app)
    .post('/name-tag/submit?kiosk=1')
    .type('form')
    .send({ memberId: String(memberId), memberIds: [String(memberId)], requestType: 'lost_tag', day: 'both', description: 'Kiosk test' });
  assert.equal(kioskSubmit.status, 200);
  assert.match(kioskSubmit.text, /data-redirect-home="1"/, 'a real kiosk submission should still auto-navigate home');
});

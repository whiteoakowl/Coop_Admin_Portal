// A real request: "All print button should show a print preview full real
// page on a page with a print button. That print button will then send it
// to the printer." Every Logs tab's Print button used to call
// window.print() directly on the live, paginated/filterable page - now
// each tab lands on its own dedicated, read-only preview page first (same
// pattern as the Allergies/Medical tab already used, see
// views/logs-allergies-print.ejs + routes/admin-logs.js's own
// /logs/allergies/print).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-logs-print-previews-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-logs-print-previews-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { ensureDayRoster } = require('../utils/classSchedule');

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

function assertIsPrintPreview(text) {
  assert.match(text, /print-preview-header/);
  assert.match(text, /onclick="window\.print\(\)"/);
}

test('Logs tabs: every Print button links to its own dedicated preview route instead of calling window.print() directly', async (t) => {
  const cookie = await loginAsAdmin();

  const tabs = [
    { tab: 'absence', printHref: '/admin/logs/absence/print' },
    { tab: 'checkinout', printHref: '/admin/logs/checkinout/print' },
    { tab: 'classcheckinout', printHref: '/admin/logs/classcheckinout/print' },
    { tab: 'nametag', printHref: '/admin/logs/nametag/print?archived=0' },
    { tab: 'classrisk', printHref: '/admin/logs/classrisk/print?filterBy=date' },
    { tab: 'missedduty', printHref: '/admin/logs/missedduty/print' },
    { tab: 'classregistration', printHref: '/admin/logs/classregistration/print' },
  ];

  for (const { tab, printHref } of tabs) {
    await t.test(`${tab} tab's Print button is a link to ${printHref}, not an inline window.print()`, async () => {
      const page = await request(app).get(`/admin/logs?tab=${tab}`).set('Cookie', cookie);
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`href="${printHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" target="_blank" aria-label="Print"`));
    });
  }

  // Substitutes has no date filter selected by default, so its own Print
  // link's href always carries at least ?day=.
  await t.test("substitutes tab's Print button is a link to its own preview route", async () => {
    const page = await request(app).get('/admin/logs?tab=substitutes').set('Cookie', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /href="\/admin\/logs\/substitutes\/print\?day=\w+" target="_blank" aria-label="Print"/);
  });

  // The already-converted Allergies tab's own Print button/route is left
  // untouched - just confirming it's still there, unaffected by this batch.
  await t.test('the allergies tab (already converted before this batch) is unaffected', async () => {
    const page = await request(app).get('/admin/logs?tab=allergies').set('Cookie', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /href="\/admin\/logs\/allergies\/print" target="_blank"/);
  });
});

test('GET /admin/logs/absence/print renders a read-only preview with the full absence/late log', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Absence Kid', 'print-absence-kid', 'student')").run()).lastInsertRowid;
  const rosterId = await ensureDayRoster('monday', 'student');
  await db
    .prepare("INSERT INTO absence_submissions (member_id, roster_id, session_date, status, reason_category, reason_text) VALUES (?, ?, '2026-03-02', 'absent', 'personal', 'print preview test')")
    .run(memberId, rosterId);

  const res = await request(app).get('/admin/logs/absence/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assertIsPrintPreview(res.text);
  assert.match(res.text, /Print Preview Absence Kid/);
});

test('GET /admin/logs/checkinout/print and /admin/logs/classcheckinout/print each render a read-only preview with the right rows for their own kind', async () => {
  const cookie = await loginAsAdmin();
  const coopRosterId = await ensureDayRoster('tuesday', 'parent');
  const coopMemberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Coop Checkin', 'print-coop-checkin', 'parent')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, '2026-03-03', 'present', 'kiosk', ?)")
    .run(coopMemberId, coopRosterId, Date.now());

  const classRosterId = (await db.prepare("INSERT INTO rosters (name, category) VALUES ('Print Preview Class Roster', 'Class Roster')").run()).lastInsertRowid;
  const classMemberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Class Checkin', 'print-class-checkin', 'student')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, '2026-03-03', 'present', 'kiosk', ?)")
    .run(classMemberId, classRosterId, Date.now());

  const coopRes = await request(app).get('/admin/logs/checkinout/print').set('Cookie', cookie);
  assert.equal(coopRes.status, 200);
  assertIsPrintPreview(coopRes.text);
  assert.match(coopRes.text, /Print Preview Coop Checkin/);
  assert.doesNotMatch(coopRes.text, /Print Preview Class Checkin/);

  const classRes = await request(app).get('/admin/logs/classcheckinout/print').set('Cookie', cookie);
  assert.equal(classRes.status, 200);
  assertIsPrintPreview(classRes.text);
  assert.match(classRes.text, /Print Preview Class Checkin/);
  assert.doesNotMatch(classRes.text, /Print Preview Coop Checkin/);
});

test('GET /admin/logs/nametag/print renders a read-only preview with the full name tag request list', async () => {
  const cookie = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Print Preview Nametag Kid', 'print-nametag-kid', 'student')").run()).lastInsertRowid;
  await db
    .prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'print preview test')")
    .run(memberId);

  const res = await request(app).get('/admin/logs/nametag/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assertIsPrintPreview(res.text);
  assert.match(res.text, /Print Preview Nametag Kid/);
});

test('GET /admin/logs/classregistration/print renders a read-only preview reflecting the real filtered data', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs/classregistration/print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assertIsPrintPreview(res.text);
});

test('GET /admin/logs/missedduty/print and /admin/logs/classrisk/print each render a read-only preview (empty-state safe)', async () => {
  const cookie = await loginAsAdmin();

  const missedRes = await request(app).get('/admin/logs/missedduty/print').set('Cookie', cookie);
  assert.equal(missedRes.status, 200);
  assertIsPrintPreview(missedRes.text);

  const riskRes = await request(app).get('/admin/logs/classrisk/print?filterBy=date').set('Cookie', cookie);
  assert.equal(riskRes.status, 200);
  assertIsPrintPreview(riskRes.text);
});

test('GET /admin/logs/substitutes/print renders a read-only preview for the requested day/date', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/logs/substitutes/print?day=monday&date=2026-03-02').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assertIsPrintPreview(res.text);
  assert.match(res.text, /Monday, 2026-03-02/);
});

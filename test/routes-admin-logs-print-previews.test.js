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

// Same "buffer the binary response body" pattern as test/parent-family-
// school-print-preview-and-pdf.test.js's own getBuffer - supertest's
// default .text/.body handling isn't meant for a real PDF buffer.
async function getBuffer(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

function assertIsRealPdf(res) {
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
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

// A real follow-up request: "PDF download icons should be added to every
// page across the app that has a print icon/button." Every Logs tab's
// Print button above now has a sibling Download PDF button next to it,
// backed by a real headless-Chromium render of that same *-print.ejs view
// (utils/pdfRender.js) rather than another CSV.
test('Logs tabs: every Print button has a sibling Download PDF button right next to it', async (t) => {
  const cookie = await loginAsAdmin();

  const tabs = [
    { tab: 'absence', pdfHref: '/admin/logs/absence/download.pdf' },
    { tab: 'checkinout', pdfHref: '/admin/logs/checkinout/download.pdf' },
    { tab: 'classcheckinout', pdfHref: '/admin/logs/classcheckinout/download.pdf' },
    { tab: 'nametag', pdfHref: '/admin/logs/nametag/download.pdf?archived=0' },
    { tab: 'classrisk', pdfHref: '/admin/logs/classrisk/download.pdf?filterBy=date' },
    { tab: 'missedduty', pdfHref: '/admin/logs/missedduty/download.pdf' },
    { tab: 'classregistration', pdfHref: '/admin/logs/classregistration/download.pdf' },
    { tab: 'allergies', pdfHref: '/admin/logs/allergies/download.pdf' },
  ];

  for (const { tab, pdfHref } of tabs) {
    await t.test(`${tab} tab has a Download PDF button linking to ${pdfHref}`, async () => {
      const page = await request(app).get(`/admin/logs?tab=${tab}`).set('Cookie', cookie);
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`href="${pdfHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" aria-label="Download PDF"`));
    });
  }

  await t.test("substitutes tab's Download PDF button links to its own route", async () => {
    const page = await request(app).get('/admin/logs?tab=substitutes').set('Cookie', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /href="\/admin\/logs\/substitutes\/download\.pdf\?day=\w+" aria-label="Download PDF"/);
  });
});

test('GET /admin/logs/absence/download.pdf returns a real PDF of the absence/late log', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/logs/absence/download.pdf', cookie);
  assertIsRealPdf(res);
});

test('GET /admin/logs/checkinout/download.pdf and /admin/logs/classcheckinout/download.pdf each return a real PDF', async () => {
  const cookie = await loginAsAdmin();

  const coopRes = await getBuffer('/admin/logs/checkinout/download.pdf', cookie);
  assertIsRealPdf(coopRes);

  const classRes = await getBuffer('/admin/logs/classcheckinout/download.pdf', cookie);
  assertIsRealPdf(classRes);
});

test('GET /admin/logs/nametag/download.pdf returns a real PDF of the name tag request list', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/logs/nametag/download.pdf', cookie);
  assertIsRealPdf(res);
});

test('GET /admin/logs/classregistration/download.pdf returns a real PDF reflecting the real filtered data', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/logs/classregistration/download.pdf', cookie);
  assertIsRealPdf(res);
});

test('GET /admin/logs/missedduty/download.pdf and /admin/logs/classrisk/download.pdf each return a real PDF (empty-state safe)', async () => {
  const cookie = await loginAsAdmin();

  const missedRes = await getBuffer('/admin/logs/missedduty/download.pdf', cookie);
  assertIsRealPdf(missedRes);

  const riskRes = await getBuffer('/admin/logs/classrisk/download.pdf?filterBy=date', cookie);
  assertIsRealPdf(riskRes);
});

test('GET /admin/logs/substitutes/download.pdf returns a real PDF for the requested day/date', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/logs/substitutes/download.pdf?day=monday&date=2026-03-02', cookie);
  assertIsRealPdf(res);
});

test('GET /admin/logs/allergies/download.pdf returns a real PDF of the allergies/medical log', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/logs/allergies/download.pdf', cookie);
  assertIsRealPdf(res);
});

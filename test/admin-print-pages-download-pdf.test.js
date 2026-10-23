// Coverage for a real request: "PDF download icons should be added to
// every page across the app that has a print icon/button." Applied here
// to the 7 Co-op Admin name-tag/badge print pages (admin-cards-duplex-
// print, admin-member-cards-print, admin-misc-badges-print, admin-name-
// tag-barcode-labels-print, admin-name-tag-barcode-print, admin-name-tag-
// bulk-print, admin-name-tag-print) - see utils/pdfRender.js (the
// headless-Chromium rendering behind every Download route below) and
// test/parent-family-school-print-preview-and-pdf.test.js for the same
// buffered-PDF-response pattern this file follows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-print-pages-download-pdf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-print-pages-download-pdf-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');
const { createSection, addItem } = require('../utils/taskList');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

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

async function postBuffer(url, cookie, fields) {
  return request(app)
    .post(url)
    .set('Cookie', cookie)
    .type('form')
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .send(fields);
}

function assertRealPdf(res, filenamePattern) {
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  if (filenamePattern) assert.match(res.headers['content-disposition'], filenamePattern);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
}

let counter = 0;
async function createMember(memberType, name) {
  counter += 1;
  const code = `printpdf${counter}`;
  return (
    await db
      .prepare('INSERT INTO members (name, barcode, member_code, member_type, active) VALUES (?, ?, ?, ?, 1) RETURNING id')
      .get(name || `${memberType} Print PDF ${counter}`, code, code, memberType)
  ).id;
}

// 1. admin-name-tag-print (GET /admin/name-tag/requests/print)
test('Name Tag Requests: Download PDF icon-btn sits next to Print, and is a real PDF', async () => {
  const { cookie } = await loginAsAdmin();
  const memberId = await createMember('student', 'Requests Download PDF Student');
  await db.prepare("INSERT INTO name_tag_requests (member_id, request_type, day, description) VALUES (?, 'lost_tag', 'monday', 'needs a new one')").run(memberId);

  const live = await request(app).get('/admin/name-tag?tab=requests').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<a class="icon-btn" href="\/admin\/name-tag\/requests\/print\?archived=0" target="_blank" aria-label="Print"/);
  assert.match(live.text, /<a class="icon-btn" href="\/admin\/name-tag\/requests\/download\.pdf\?archived=0" aria-label="Download PDF"/);

  const res = await getBuffer('/admin/name-tag/requests/download.pdf?archived=0', cookie);
  assertRealPdf(res, /attachment; filename="name-tag-requests\.pdf"/);
});

// 2. admin-name-tag-bulk-print (POST /admin/name-tag/print and
// /admin/name-tag/print-plain-parent)
test('Name Tags bulk print: Download PDF buttons sit next to Print Selected and Print Plain Parent Tags, and are real PDFs', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const studentId = await createMember('student', 'Bulk Download PDF Student');
  const parentId = await createMember('parent', 'Bulk Download PDF Parent');

  const live = await request(app).get('/admin/name-tag?tab=print').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<button type="submit" class="primary-btn name-tag-bulk-submit">Print Selected<\/button>/);
  assert.match(live.text, /formaction="\/admin\/name-tag\/download\.pdf"/);
  assert.match(live.text, /formaction="\/admin\/name-tag\/download-plain-parent\.pdf"/);
  assert.match(live.text, /formaction="\/admin\/name-tag\/download-barcodes\.pdf"/);

  const bulkRes = await postBuffer('/admin/name-tag/download.pdf', cookie, { memberIds: String(studentId), _csrf: csrfToken });
  assertRealPdf(bulkRes, /attachment; filename="name-tags\.pdf"/);

  const plainParentRes = await postBuffer('/admin/name-tag/download-plain-parent.pdf', cookie, { memberIds: String(parentId), _csrf: csrfToken });
  assertRealPdf(plainParentRes, /attachment; filename="plain-parent-name-tags\.pdf"/);
});

// 3. admin-name-tag-barcode-print (POST /admin/name-tag/print-barcodes)
test('Barcodes Only sheet: Download PDF button sits next to Print, and is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const memberId = await createMember('student', 'Barcode Download PDF Student');

  const live = await request(app).get('/admin/name-tag?tab=print').set('Cookie', cookie);
  assert.match(live.text, /formaction="\/admin\/name-tag\/download-barcodes\.pdf"/);

  const res = await postBuffer('/admin/name-tag/download-barcodes.pdf', cookie, { memberIds: String(memberId), _csrf: csrfToken });
  assertRealPdf(res, /attachment; filename="barcodes\.pdf"/);
});

// 4. admin-name-tag-barcode-labels-print (POST
// /admin/name-tag/print-barcode-labels, live form on the Design/Print hub)
test('Barcode Labels sheet: Download PDF button sits next to Print, and is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const memberId = await createMember('student', 'Barcode Label Download PDF Student');

  const live = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.match(live.text, /<form method="POST" action="\/admin\/name-tag\/print-barcode-labels"/);
  assert.match(live.text, /formaction="\/admin\/name-tag\/download-barcode-labels\.pdf"/);

  const res = await postBuffer('/admin/name-tag/download-barcode-labels.pdf', cookie, { memberIds: String(memberId), _csrf: csrfToken });
  assertRealPdf(res, /attachment; filename="barcode-labels\.pdf"/);
});

// 5. admin-cards-duplex-print - reachable from the Design/Print hub's bulk
// "Name Tags + Schedule Cards (Front & Back)" picker (POST
// /admin/design/print-duplex) AND from a single member's own Cards dialog
// (GET /admin/members/:id/cards/print?layout=frontBack).
test('Name Tags + Schedule Cards (Front & Back): Download PDF button sits next to Print on the bulk Design/Print panel, and is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const memberId = await createMember('student', 'Duplex Download PDF Student');

  const live = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.match(live.text, /<div id="print-cardsDuplex-section" hidden>/);
  assert.match(live.text, /formaction="\/admin\/design\/download-duplex\.pdf"/);

  const res = await postBuffer('/admin/design/download-duplex.pdf', cookie, { memberIds: String(memberId), _csrf: csrfToken });
  assertRealPdf(res, /attachment; filename="name-tags-and-schedule-cards\.pdf"/);
});

test('Member Cards dialog, Front & Back layout: Download PDF button sits next to Print, and is a real PDF', async () => {
  const { cookie } = await loginAsAdmin();
  const memberId = await createMember('student', 'Single Member Duplex Download Kid');

  const fragment = await request(app).get(`/admin/members/${memberId}/cards-fragment`).set('Cookie', cookie);
  assert.equal(fragment.status, 200);
  assert.match(fragment.text, new RegExp(`formaction="/admin/members/${memberId}/cards/download\\.pdf"`));

  const res = await getBuffer(`/admin/members/${memberId}/cards/download.pdf?layout=frontBack`, cookie);
  assertRealPdf(res, /attachment; filename="member-cards\.pdf"/);
});

// 6. admin-member-cards-print (GET /admin/members/:id/cards/print with
// layout=nameTag or layout=scheduleCard)
test('Member Cards dialog, Name Tag / Schedule Card layouts: Download PDF is a real PDF for each', async () => {
  const { cookie } = await loginAsAdmin();
  const memberId = await createMember('student', 'Single Card Download Kid');

  const nameTagRes = await getBuffer(`/admin/members/${memberId}/cards/download.pdf?layout=nameTag`, cookie);
  assertRealPdf(nameTagRes, /attachment; filename="member-cards\.pdf"/);

  const scheduleCardRes = await getBuffer(`/admin/members/${memberId}/cards/download.pdf?layout=scheduleCard`, cookie);
  assertRealPdf(scheduleCardRes, /attachment; filename="member-cards\.pdf"/);
});

test('Member Cards dialog: a nonexistent member 404s on Download PDF, same as Print', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/members/999999/cards/download.pdf?layout=nameTag').set('Cookie', cookie);
  assert.equal(res.status, 404);
});

// 7. admin-misc-badges-print - reachable from the Setup/Cleanup Bypass
// Badges quantity form (POST /admin/design/badges/bypass/print) and the
// Setup/Cleanup Badges picker (POST /admin/design/badges/setupCleanup/print).
test('Setup/Cleanup Bypass Badges: Download PDF button sits next to Print, and is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const live = await request(app).get('/admin/design?tab=print&print=bypassBadge').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<form method="POST" action="\/admin\/design\/badges\/bypass\/print"/);
  assert.match(live.text, /formaction="\/admin\/design\/badges\/bypass\/download\.pdf"/);

  const res = await postBuffer('/admin/design/badges/bypass/download.pdf', cookie, { quantity: '3', _csrf: csrfToken });
  assertRealPdf(res, /attachment; filename="setup-cleanup-bypass-badges\.pdf"/);
});

test('Setup/Cleanup Badges picker: Download PDF button sits next to Print, and is a real PDF', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const sectionId = await createSection('monday', 'Download PDF Team', null);
  const itemId = await addItem(sectionId, 'Wipe down the counters');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);

  const live = await request(app).get('/admin/design?tab=print&print=setupCleanupBadges').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /<form method="POST" action="\/admin\/design\/badges\/setupCleanup\/print"/);
  assert.match(live.text, /formaction="\/admin\/design\/badges\/setupCleanup\/download\.pdf"/);

  const res = await postBuffer('/admin/design/badges/setupCleanup/download.pdf', cookie, { badgeIds: String(badge.id), _csrf: csrfToken });
  assertRealPdf(res, /attachment; filename="setupCleanup-badges\.pdf"/);
});

test('Custom Badges picker shows Download PDF too, but Main Admin\'s own Design/Print hub (a different route entirely) does not', async () => {
  const { cookie } = await loginAsAdmin();
  const live = await request(app).get('/admin/design?tab=print&print=customBadges').set('Cookie', cookie);
  assert.match(live.text, /formaction="\/admin\/design\/badges\/custom\/download\.pdf"/);
});

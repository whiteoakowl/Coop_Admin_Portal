// Main Admin Portal's own mirror of routes/admin-design.js's Class
// Check-In QR Codes, Playground Check-In QR Codes, and Library Barcodes
// print panels (routes/main-admin-name-tags.js, same per-portal
// duplication convention this app uses throughout - see test/routes-
// classcheckin-qr-print.test.js, test/routes-playground-qr-print.test.js
// and test/routes-design-library-barcodes.test.js for the Co-op Admin
// Portal's own coverage of the same pages). A real user request: "PDF
// download icons should be added to every page across the app that has
// a print icon/button." Each download.pdf route below renders the exact
// same *-print.ejs view the Print button opens, through headless
// Chromium (see utils/pdfRender.js) - PDF generation via real headless
// Chromium is slow (~1-2s each) - expected, not a bug.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-qr-barcode-download-pdf-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-qr-barcode-download-pdf-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const { createClass } = require('../utils/classSchedule');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app)
    .post('/login')
    .type('form')
    .send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
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

test('Main Admin Class Check-In QR Codes: the picker offers a Download PDF button, and download.pdf is a real PDF', async () => {
  const cookie = await loginAsMainAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Main Admin QR Download Class', room: 'Room 1' });

  const live = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, new RegExp(`name="classIds" value="${classId}"`));
  assert.match(live.text, /formaction="\/main-admin\/name-tags\/print-classcheckin-qr\/download\.pdf" formmethod="GET"[^>]*aria-label="Download PDF"/);

  const res = await getBuffer(`/main-admin/name-tags/print-classcheckin-qr/download.pdf?classIds=${classId}`, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="class-checkin-qr-codes\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
  // A broken QR render would still return 200 with a near-blank page.
  assert.ok(res.body.length > 5000, `expected a non-trivial PDF, got ${res.body.length} bytes`);
});

test('Main Admin Playground Check-In QR Codes: the panel offers a Download PDF link, and download.pdf is a real PDF', async () => {
  const cookie = await loginAsMainAdmin();

  const live = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, /href="\/main-admin\/name-tags\/print-playground-qr\/download\.pdf" aria-label="Download PDF"/);

  const res = await getBuffer('/main-admin/name-tags/print-playground-qr/download.pdf', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="playground-qr-codes\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
  assert.ok(res.body.length > 5000, `expected a non-trivial PDF, got ${res.body.length} bytes`);
});

test('Main Admin Library Barcodes: the picker offers a Download PDF button, and download.pdf is a real PDF', async () => {
  const cookie = await loginAsMainAdmin();

  await db.prepare("INSERT INTO library_item_types (name) VALUES ('Fiction') ON CONFLICT (name) DO NOTHING").run();
  const itemId = (
    await db.prepare("INSERT INTO library_items (title, barcode, type) VALUES ('Main Admin Download Book', 'main-lib-000001', 'Fiction')").run()
  ).lastInsertRowid;

  const live = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(live.status, 200);
  assert.match(live.text, new RegExp(`name="itemIds" value="${itemId}"`));
  assert.match(live.text, /formaction="\/main-admin\/name-tags\/print-library-barcodes\/download\.pdf" formmethod="GET"[^>]*aria-label="Download PDF"/);

  const res = await getBuffer(`/main-admin/name-tags/print-library-barcodes/download.pdf?itemIds=${itemId}`, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="library-barcodes\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
  assert.ok(res.body.length > 5000, `expected a non-trivial PDF, got ${res.body.length} bytes`);
});

// Real HTTP-level coverage for a real request: "create qr codes for the
// playground check in link" (routes/admin-design.js's print-playground-qr
// route, admin-playground-qr-print.ejs). Unlike Class Check-In QR Codes,
// there's no picker/selection step - the playground always has exactly
// the same 8 (day, hour) slots, so this always prints all of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `playground-qr-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `playground-qr-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

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

test('the Playground Check-In QR panel is offered on the Print tab with a Print link and a Download PDF button', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Playground Check-In QR Codes/);
  assert.match(res.text, /href="\/admin\/design\/print-playground-qr"/);
  // A real request: "the download should be a pdf of exactly how it
  // would also look when printing."
  assert.match(res.text, /href="\/admin\/design\/print-playground-qr\/download\.pdf" aria-label="Download PDF"/);
});

test('printing renders one page per day, 4 QR cells each, encoding every hour\'s absolute check-in URL', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/design/print-playground-qr').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const pageCount = (res.text.match(/class="qr-sheet-page"/g) || []).length;
  assert.equal(pageCount, 2, 'one page for Monday, one for Wednesday');
  const cellCount = (res.text.match(/class="qr-sheet-cell"/g) || []).length;
  assert.equal(cellCount, 8, '4 hours x 2 days');

  assert.match(res.text, /Monday/);
  assert.match(res.text, /Wednesday/);
  for (const day of ['monday', 'wednesday']) {
    for (let h = 1; h <= 4; h++) {
      assert.match(res.text, new RegExp(`data-qr-value="http://[^"]*/kiosk/class-checkin/playground/${day}/${h}/attendance"`));
    }
  }

  assert.match(res.text, /<script src="\/js\/vendor\/qrcode\.min\.js"><\/script>/);
  assert.match(res.text, /<script src="\/js\/classcheckin-qr-print\.js"><\/script>/);
});

// A real request: "the download should be a pdf of exactly how it would
// also look when printing" - routes/admin-design.js's new GET
// /design/print-playground-qr/download.pdf route renders the exact same
// admin-playground-qr-print.ejs view through headless Chromium (see
// utils/pdfRender.js). PDF generation via real headless Chromium is
// slow (~1-2s) - expected, not a bug.
test('downloading the Playground QR sheet as a PDF renders a real, non-trivial PDF', async () => {
  const cookie = await loginAsAdmin();
  const res = await getBuffer('/admin/design/print-playground-qr/download.pdf', cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /attachment; filename="playground-qr-codes\.pdf"/);
  assert.equal(res.body.slice(0, 5).toString(), '%PDF-');
  // A broken QR render would still return 200 with a near-blank page -
  // a real two-page sheet (Monday + Wednesday) full of rendered QR codes
  // comes back well into the tens of KB, not a trivial handful of bytes.
  assert.ok(res.body.length > 5000, `expected a non-trivial PDF, got ${res.body.length} bytes`);
});

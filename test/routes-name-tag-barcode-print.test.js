// Real HTTP-level coverage for a bug report this session: barcode-only
// print sheet (POST /admin/name-tag/print-barcodes) names were too small,
// and long names could overflow/truncate their cell. Fixed with public/js/
// barcode-print-shrink-name.js, which shrinks only the name text (never
// the barcode itself - see that script's own comment on why) down to fit,
// then triggers window.print() itself once shrinking is done - this page
// intentionally does NOT use the generic public/js/print-auto.js every
// other print-preview page uses, since a plain 'load'-based auto-print
// can't guarantee it fires after shrinking has actually finished. This
// suite locks in that markup contract; the shrink/measurement behavior
// itself was verified live via Playwright (real DOM layout, not something
// a jsdom-free route test can meaningfully assert on).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-barcode-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-barcode-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('barcode-only print sheet loads the shrink-to-fit script, not the generic auto-print script', async (t) => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/name-tag?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const { lastInsertRowid: memberId } = db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jordan Fitzgerald-Montgomery', 'Jordan Fitzgerald-Montgomery', 'student')")
    .run();

  const res = await request(app)
    .post('/admin/name-tag/print-barcodes')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: memberId, _csrf: csrfToken });
  assert.equal(res.status, 200);

  await t.test('the shrink-to-fit script is included', () => {
    assert.match(res.text, /<script src="\/js\/barcode-print-shrink-name\.js">/);
  });

  await t.test('the generic sitewide print-auto.js is deliberately not included here', () => {
    assert.doesNotMatch(res.text, /<script src="\/js\/print-auto\.js">/);
  });

  await t.test('the member name still renders in its cell for the script to act on', () => {
    assert.match(res.text, /<div class="barcode-cell-name">Jordan Fitzgerald-Montgomery<\/div>/);
  });
});

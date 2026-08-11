// Real HTTP-level coverage for two bug reports this session on the
// barcode-only print sheet (POST /admin/name-tag/print-barcodes):
// - Names were too small, and a long one could overflow/get cut off by
//   its cell.
// - Every barcode's outer box was forced to the same fixed width via CSS
//   regardless of how long the encoded value (= that member's name) was,
//   which squashed a long name's barcode (more bars) into visibly
//   thinner bars than a short name's - "different sized" barcodes even
//   though the boxes themselves matched.
// Both fixed by public/js/barcode-print-shrink-name.js: it shrinks only
// the name text (never the barcode) down to fit, and renders each
// barcode itself with a fixed bar width instead of using the shared
// public/js/name-tag-render.js renderer (which is exactly right for the
// name-tag designer's manually-sized elements, but wrong for a sheet that
// wants every bar the same thickness) - then triggers window.print()
// itself once both are done, since this page intentionally skips the
// generic public/js/print-auto.js (a plain 'load'-based auto-print can't
// guarantee it fires after rendering/shrinking have actually finished).
// This suite locks in that markup contract; the actual rendered
// bar-width/shrink behavior was verified live via Playwright (real DOM
// layout, not something a jsdom-free route test can meaningfully assert
// on).
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

  await t.test('the barcode+shrink script is included', () => {
    assert.match(res.text, /<script src="\/js\/barcode-print-shrink-name\.js">/);
  });

  await t.test('the generic sitewide print-auto.js and shared name-tag-render.js are deliberately not included here', () => {
    assert.doesNotMatch(res.text, /<script src="\/js\/print-auto\.js">/);
    assert.doesNotMatch(res.text, /<script src="\/js\/name-tag-render\.js">/);
  });

  await t.test('the barcode svg is not badge-el-barcode (the shared renderer\'s selector) - this page renders its own', () => {
    assert.match(res.text, /<svg class="barcode-cell-svg" data-barcode-value="Jordan Fitzgerald-Montgomery">/);
    assert.doesNotMatch(res.text, /class="badge-el-barcode/);
  });

  await t.test('the member name still renders in its cell for the script to act on', () => {
    assert.match(res.text, /<div class="barcode-cell-name">Jordan Fitzgerald-Montgomery<\/div>/);
  });
});

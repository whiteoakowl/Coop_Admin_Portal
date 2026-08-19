// Real HTTP-level coverage for POST /admin/name-tag/print-barcode-labels
// (the Avery 08160-style mailing label sheet: barcode + name + ID number
// per label) - mirrors test/routes-name-tag-barcode-print.test.js's own
// markup-contract coverage for the barcode-only card sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `name-tag-barcode-labels-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `name-tag-barcode-labels-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('POST /admin/name-tag/print-barcode-labels', async (t) => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/name-tag?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Riley Chen', '482913', '482913', 'student')")
    .run();

  await t.test('renders the barcode, name, and ID number for each selected member', async () => {
    const res = await request(app)
      .post('/admin/name-tag/print-barcode-labels')
      .set('Cookie', cookie)
      .type('form')
      .send({ memberIds: memberId, _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /<svg class="barcode-cell-svg" data-barcode-value="482913">/);
    assert.match(res.text, /<div class="barcode-cell-name">Riley Chen<\/div>/);
    assert.match(res.text, /<div class="barcode-cell-id">ID: 482913<\/div>/);
    assert.match(res.text, /class="avery-label-sheet-page"/);
    // A real bug report - name tag print pages "drifting off the pages...
    // mobile and desktop" - traced to .badge-sheet-page/.print-page's
    // on-screen mobile-viewport shrink-to-fit (print-auto.js) not
    // covering every physical-page-sized print sheet in the app.
    // .avery-label-sheet-page (this page's own sheet class) is now one
    // of its targets too, same as the badge/member print sheets.
    assert.match(res.text, /<script src="\/js\/print-auto\.js">/);
  });

  await t.test('no members selected redirects with an error instead of rendering an empty sheet', async () => {
    const res = await request(app)
      .post('/admin/name-tag/print-barcode-labels')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
  });
});

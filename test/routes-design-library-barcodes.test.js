// Real HTTP-level coverage for the Design/Print hub's new "Library
// Barcodes" print panel (routes/admin-design.js's POST /design/print-
// library-barcodes). A real user request: "Under printing add printing
// library barcodes. Drop down menu shows category choices. After selecting
// a category it shows a list of library catalog items in that category to
// print avery labels. Use the same template as the barcode only badges for
// members."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `design-library-barcodes-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `design-library-barcodes-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
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

test('Design/Print: Library Barcodes panel + print', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await db.prepare("INSERT INTO library_item_types (name) VALUES ('Fiction') ON CONFLICT (name) DO NOTHING").run();
  await db.prepare("INSERT INTO library_item_types (name) VALUES ('Science') ON CONFLICT (name) DO NOTHING").run();
  const fictionId = (
    await db.prepare("INSERT INTO library_items (title, barcode, type) VALUES ('Charlotte''s Web', 'lib-000001', 'Fiction')").run()
  ).lastInsertRowid;
  const scienceId = (
    await db.prepare("INSERT INTO library_items (title, barcode, type) VALUES ('Rocks and Minerals', 'lib-000002', 'Science')").run()
  ).lastInsertRowid;

  await t.test('the Print tab offers Library Barcodes with a category dropdown and both items listed', async () => {
    const res = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Library Barcodes/);
    assert.match(res.text, /All Categories/);
    assert.match(res.text, /<option value="Fiction">Fiction<\/option>/);
    assert.match(res.text, /<option value="Science">Science<\/option>/);
    assert.match(res.text, /Charlotte&#39;s Web/);
    assert.match(res.text, /Rocks and Minerals/);
    assert.match(res.text, /class="library-picker-row" data-type="Fiction"/);
  });

  await t.test('printing selected items renders the same Avery label template as member barcode labels', async () => {
    const res = await request(app)
      .post('/admin/design/print-library-barcodes')
      .set('Cookie', cookie)
      .type('form')
      .send({ itemIds: [String(fictionId), String(scienceId)], _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /avery-label-sheet-page/);
    assert.match(res.text, /avery-label-grid/);
    assert.match(res.text, /Charlotte&#39;s Web/);
    assert.match(res.text, /Rocks and Minerals/);
    assert.match(res.text, /data-barcode-value="lib-000001"/);
    assert.match(res.text, /barcode-cell-id">Fiction/);
    // A real bug report - name tag print pages "drifting off the pages...
    // mobile and desktop" - traced to .badge-sheet-page/.print-page's
    // on-screen mobile-viewport shrink-to-fit (print-auto.js) not
    // covering every physical-page-sized print sheet in the app.
    // .avery-label-sheet-page (this page's own sheet class) is now one
    // of its targets too, same as the badge/member print sheets.
    assert.match(res.text, /<script src="\/js\/print-auto\.js">/);
  });

  await t.test('printing with nothing selected redirects with an error', async () => {
    const res = await request(app)
      .post('/admin/design/print-library-barcodes')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=/);
  });
});

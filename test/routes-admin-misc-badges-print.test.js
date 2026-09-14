// Real HTTP-level coverage for routes/admin-misc-badges.js's Setup/
// Cleanup badge print route - two real bug reports:
//
//   1. "the setup/cleanup cards when you click to print them it does not
//      show barcodes. you can see the barcode on the design page, but not
//      printing." Root cause: this page never loaded the JsBarcode vendor
//      script or name-tag-render.js (which calls JsBarcode against every
//      .badge-el-barcode svg) - every other badge/name-tag print page in
//      this app loads both, this one was the one left out. The barcode
//      svg itself renders fine (with a real data-barcode-value
//      attribute), it's just permanently empty with nothing to draw bars
//      into it.
//   2. "the description of the tasks, do not reduce the font size to keep
//      it all on one line. keep the same font size and simply continue
//      the tasks description on the next line below it." The task/
//      description element no longer sets autoFitText, so renderTextEl
//      (name-tag-render-core.js) no longer forces it onto one nowrap
//      line - it wraps normally at its own fixed font size instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-misc-badges-print-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-misc-badges-print-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createSection, addItem } = require('../utils/taskList');

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

test('printing a real Setup/Cleanup badge loads the barcode scripts and carries the task\'s real barcode value', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const sectionId = await createSection('monday', 'Kitchen Team', null);
  const itemId = await addItem(sectionId, 'Wipe down all counters and sinks');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);
  assert.ok(badge.barcode, 'the real task should have gotten a real barcode');

  const res = await request(app)
    .post('/admin/design/badges/setupCleanup/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ badgeIds: String(badge.id), _csrf: csrfToken });

  assert.equal(res.status, 200);
  // The actual regression: these two script tags were missing, so the
  // barcode svg's data-barcode-value never got drawn into real bars.
  assert.match(res.text, /<script src="\/js\/vendor\/jsbarcode\.min\.js"><\/script>/);
  assert.match(res.text, /<script src="\/js\/name-tag-render\.js"><\/script>/);
  assert.match(res.text, /data-type="barcode" data-barcode-value="/);
  assert.match(res.text, new RegExp(`data-barcode-value="${badge.barcode}"`));
});

test('the printed task/description text does not force single-line shrink-to-fit (nowrap) - it wraps at a fixed size instead', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const sectionId = await createSection('wednesday', 'House Team', null);
  const itemId = await addItem(
    sectionId,
    'Vacuum the kitchen, admin office, and large front classroom before everyone leaves for the day'
  );
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);

  const res = await request(app)
    .post('/admin/design/badges/setupCleanup/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ badgeIds: String(badge.id), _csrf: csrfToken });

  assert.equal(res.status, 200);
  // data-autofit="1" is only stamped on an element when autoFitText is
  // set (name-tag-render-core.js's renderTextEl) - the task/description
  // element should no longer carry it.
  const taskElMatch = /<div class="badge-el badge-el-text" data-id="task" data-type="text"([^>]*)>/.exec(res.text);
  assert.ok(taskElMatch, 'the task element should be present');
  assert.doesNotMatch(taskElMatch[1], /data-autofit="1"/, 'the task element should not be marked autofit anymore');
  assert.match(res.text, /Vacuum the kitchen, admin office, and large front classroom/, 'the full task text should be present, not truncated');
  // day/team/leader keep their own autoFitText - only description changed.
  assert.match(res.text, /data-id="team" data-type="text" data-autofit="1"/);
});

// A real request: "Setup/cleanup badges printing. the task # should be in
// the top right corner of the badge." taskNumber is the task's 1-indexed
// position within its own Task List section (utils/taskList.js's
// itemsForSection/taskNumbersByItemId) - not the badge's own barcode -
// threaded into miscBadgeRowData by this print route since a misc_badges
// row alone doesn't carry its section's item ordering.
test('printing real Setup/Cleanup badges stamps each one with its own task\'s 1-indexed position in its section', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const sectionId = await createSection('monday', 'Yard Team', null);
  const firstItemId = await addItem(sectionId, 'Rake the leaves by the front door');
  const secondItemId = await addItem(sectionId, 'Sweep the back patio');
  const thirdItemId = await addItem(sectionId, 'Empty the outdoor trash cans');
  const firstBadge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(firstItemId);
  const secondBadge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(secondItemId);
  const thirdBadge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(thirdItemId);

  const res = await request(app)
    .post('/admin/design/badges/setupCleanup/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ badgeIds: [String(firstBadge.id), String(secondBadge.id), String(thirdBadge.id)], _csrf: csrfToken });

  assert.equal(res.status, 200);
  // Cards print in badge_number (barcode) order, not task position, so
  // just check the full {1,2,3} set showed up somewhere, not a specific
  // card-by-card order.
  const taskNumberEls = [...res.text.matchAll(/data-id="task-number" data-type="text"[\s\S]*?<span class="badge-el-text-inner"[^>]*>([^<]*)<\/span>/g)];
  assert.equal(taskNumberEls.length, 3, 'each printed card should carry its own task-number element');
  assert.deepEqual(taskNumberEls.map((m) => m[1].trim()).sort(), ['1', '2', '3']);
});

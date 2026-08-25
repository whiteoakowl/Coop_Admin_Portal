// Real HTTP-level coverage for routes/admin-misc-badges.js's DELETE
// route (POST /admin/design/badges/:type/delete/:id). The route itself
// was already fully implemented (deleteMiscBadge + redirect) but had no
// way to reach it from views/partials/misc-badge-print-panel.ejs at all
// - a real bug, since that left no way to remove a single custom badge
// short of re-importing the entire list without it.
//
// The first fix attempt introduced a second, more subtle bug: the new
// per-badge delete <form> was nested INSIDE the panel's existing print
// <form>. A <form> nested inside another <form> is invalid HTML and gets
// silently dropped by the browser's own parser - the element never
// actually makes it into the live DOM at all, even though it's right
// there, completely well-formed-looking, in the raw server-rendered
// HTML (so a plain string/regex check against the response body alone
// would NOT have caught this - confirmed live via Playwright that
// clicking the delete button did nothing at all before the fix, then
// worked correctly once the delete forms were moved to be standalone,
// same as every other per-row delete form in this app). This test
// guards the actual DOM validity, not just the response text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-misc-badges-delete-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-misc-badges-delete-test-uploads-${process.pid}`);
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

test('the Custom badge panel offers a working delete button whose <form> is NOT nested inside the print <form>', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await db
    .prepare("INSERT INTO misc_badges (badge_type, badge_number, title, description, barcode) VALUES ('custom', '1', 'Delete Me Badge', 'A badge to verify delete works', 'delete-me-badge-barcode')")
    .run();
  const badge = await db.prepare("SELECT * FROM misc_badges WHERE title = 'Delete Me Badge'").get();

  const page = await request(app).get('/admin/design?tab=print&print=customBadges').set('Cookie', cookie);
  assert.equal(page.status, 200);

  // The actual regression: the delete form's opening <form> tag must
  // appear AFTER the print form's own closing </form> tag - if it comes
  // before (nested inside), the browser silently drops it from the DOM
  // even though this exact same text is present in the response body.
  const printFormClose = page.text.indexOf(`</form>`, page.text.indexOf(`id="custom-badge-print-form"`));
  const deleteFormOpen = page.text.indexOf(`id="custom-badge-delete-form-${badge.id}"`);
  assert.ok(printFormClose > -1 && deleteFormOpen > -1, 'both the print form close tag and the delete form should be present');
  assert.ok(deleteFormOpen > printFormClose, 'the delete form must be a sibling AFTER the print form closes, not nested inside it');

  assert.match(page.text, new RegExp(`action="/admin/design/badges/custom/delete/${badge.id}"`));
  assert.match(page.text, /data-confirm="Delete &quot;Delete Me Badge&quot;\? This cannot be undone\."/);

  const res = await request(app)
    .post(`/admin/design/badges/custom/delete/${badge.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(res.status, 302);

  const stillThere = await db.prepare('SELECT id FROM misc_badges WHERE id = ?').get(badge.id);
  assert.equal(stillThere, undefined, 'the badge should actually be deleted');
});

test('a setupCleanup (task-derived) badge never gets a delete button - deleting it directly would desync it from its own task', async () => {
  const { cookie } = await loginAsAdmin();
  await db
    .prepare("INSERT INTO misc_badges (badge_type, badge_number, title, barcode) VALUES ('setupCleanup', null, 'General Bypass Badge', 'bypass-test-barcode')")
    .run();

  const page = await request(app).get('/admin/design?tab=print&print=setupCleanupBadges').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /setupCleanup-badge-delete-form-/, 'setupCleanup badges are task-derived and must not offer a manual delete');
});

// A real request: "main admin and co-op admin, members... member rows
// remove primary column. it can already be seen when viewing the
// profile." The Members list is card-based (not a table), so this drops
// the inline "Primary" badge from each member-row-card instead of a
// literal column - Co-op Admin's own member profile page didn't show
// Primary Parent status at all before this, so it gained that line to
// keep the claim true there too (Main Admin's profile already had it).
// The search-bar-next-to-filter-dropdown layout this same request
// re-asked for was already in place from an earlier round (.members-
// search-filter-row) - covered here too so it stays pinned down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `members-primary-badge-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `members-primary-badge-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';
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

async function makeFamily(label) {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`${label} Family`)).lastInsertRowid;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1)")
      .run(`${label} Primary Parent`, `${label}-primary`, familyId)
  ).lastInsertRowid;
  return { familyId, parentId };
}

test('Main Admin Members list: no inline Primary badge, search bar sits next to filter dropdown', async () => {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  await makeFamily('MainAdminBadge');

  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /MainAdminBadge Primary Parent/);
  assert.doesNotMatch(res.text, /primary-parent-badge/);
  // A real request: "Filter button and search bar should be on the same
  // row" - Filter (partials/members-type-filter.ejs, including its own
  // nested <div>s) now renders inline inside .members-search-filter-row
  // for the Members tab too, same as it already did for Archive - which
  // breaks a regex trying to capture "up to the next </div>" (it would
  // stop at one of the filter dialog's own inner divs instead of the
  // row's own closing tag). A plain whole-page match is robust against
  // that nesting and still proves both are present.
  assert.match(res.text, /class="members-search-filter-row no-print">[\s\S]*?onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)"/, 'expected Filter to lead the search-filter row');
  assert.match(res.text, /class="members-search-bar"/);
  // A real request: "Filter button should be on the same row as icons"
  // moved Filter (and its own dialog, including this Family <select>)
  // into the icon row - still on the page either way, so a plain
  // whole-page match proves the same thing without needing to carve out
  // one row's own substring (nested <div>s inside the dialog make that
  // fragile now - see test/routes-main-admin-members-mobile-button-
  // order.test.js's own comment on why).
  assert.match(res.text, /class="category-filter"/);
});

test('Co-op Admin Members list: no inline Primary badge, Filter moved into the button toolbar same as Main Admin', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const { familyId } = await makeFamily('CoopAdminBadge');
  // Co-op Admin's own Members list only shows families with an enrolled
  // student (real request: "members only appear on the member list for
  // co-op admin portal if they are registered for classes") - makeFamily
  // only creates a parent, so this family needs a registered student of
  // its own to show up here at all.
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('CoopAdminBadge Kid', 'coopadminbadge-kid', 'student', ?) RETURNING id").get(familyId)
  ).id;
  const fixtureClassId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Badge Fixture Class') RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(fixtureClassId, studentId);

  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /CoopAdminBadge Primary Parent/);
  assert.doesNotMatch(res.text, /primary-parent-badge/);
  // A real request: "filter button and search bar on co-op admin portal
  // members should be the same as main admin portal members" - the
  // search-filter-row now holds only the search bar; Filter is its own
  // orange button in the toolbar above, opening #members-filter-dialog.
  const rowMatch = /<div class="members-search-filter-row no-print">([\s\S]*?)<\/div>/.exec(res.text);
  assert.ok(rowMatch, 'expected a members-search-filter-row wrapping the search bar');
  assert.match(rowMatch[1], /class="members-search-bar"/);
  assert.doesNotMatch(rowMatch[1], /class="category-filter"/);
  assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('members-filter-dialog'\)\.showModal\(\)">/);
  assert.match(res.text, /<dialog id="members-filter-dialog" class="member-picker-dialog">/);
});

test('Co-op Admin member profile still shows Primary Parent status now that the list row drops it', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const { parentId } = await makeFamily('ProfileBadge');

  const res = await request(app).get(`/admin/members/${parentId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Parent\s*&middot;\s*Primary Parent/);
});

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
  // Search bar and Filter dropdown share one row (.members-search-filter-row),
  // left-aligned, not split across separate toolbar rows.
  const rowMatch = /<div class="members-search-filter-row no-print">([\s\S]*?)<div class="roster-toolbar/.exec(res.text);
  assert.ok(rowMatch, 'expected a members-search-filter-row wrapping both the search bar and filter dropdown');
  assert.match(rowMatch[1], /class="members-search-bar"/);
  assert.match(rowMatch[1], /class="category-filter"/);
});

test('Co-op Admin Members list: no inline Primary badge, search bar sits next to filter dropdown', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  await makeFamily('CoopAdminBadge');

  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /CoopAdminBadge Primary Parent/);
  assert.doesNotMatch(res.text, /primary-parent-badge/);
  const rowMatch = /<div class="members-search-filter-row no-print">([\s\S]*?)<div class="roster-toolbar/.exec(res.text);
  assert.ok(rowMatch, 'expected a members-search-filter-row wrapping both the search bar and filter dropdown');
  assert.match(rowMatch[1], /class="members-search-bar"/);
  assert.match(rowMatch[1], /class="category-filter"/);
});

test('Co-op Admin member profile still shows Primary Parent status now that the list row drops it', async () => {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const { parentId } = await makeFamily('ProfileBadge');

  const res = await request(app).get(`/admin/members/${parentId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<dt>Primary Parent<\/dt>\s*<dd>Yes<\/dd>/);
});

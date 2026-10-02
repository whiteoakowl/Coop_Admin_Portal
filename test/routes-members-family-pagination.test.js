// A real bug report: "Main admin portal and co-op admin portal, member
// list. The drop down for the last family on the page is sometimes
// putting part of the family on the next page. Families should stay
// together on the member list. Each member list page doesn't have to be
// an exact number of members." utils/members.js's own
// sortMembersByFamily already groups a family into one contiguous block,
// sorted by the primary parent's (or alphabetically-first member's) last
// name - but utils/pagination.js's own plain fixed-pageSize slice had no
// idea where one family's block ended and the next began, so a family
// landing right at the page boundary got cut mid-group. The accordion
// toggle's own "+N more" count (views/admin-members.ejs) reads
// members.filter(...) against whatever slice actually landed on this
// page, so a split family also under-counted there, on top of its
// missing members silently reappearing, ungrouped, at the top of the
// next page.
//
// Covers the Co-op Admin Members list (/admin/members); see test/
// routes-main-admin-members-family-pagination.test.js for the same
// coverage on Main Admin's own Members list - each gets its own file/DB,
// same "one isolated instance per test file" convention every other
// test/routes-*.test.js already follows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-members-family-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-members-family-pagination-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin Members list keeps the last family on a page together instead of splitting it across pages', async () => {
  const cookie = await loginAsAdmin();

  // 48 solo members whose own "last name" (utils/members.js's own
  // lastNameOf - the FINAL whitespace-separated word) sorts well before
  // "Zzyszewski", a 4-person Zzyszewski family right where the default
  // 50-per-page boundary would otherwise fall 2 members into it, and one
  // more solo member sorting after the family - so page 1's naive
  // 50-item cutoff would otherwise land squarely inside the family.
  const soloInsert = db.prepare("INSERT INTO members (name, barcode, member_type) VALUES (?, ?, 'student')");
  for (let i = 1; i <= 48; i++) {
    await soloInsert.run(`Aardvark Kid ${String(i).padStart(2, '0')}`, `last-family-solo-${i}`);
  }
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Zzyszewski')").run()).lastInsertRowid;
  const familyInsert = db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES (?, ?, ?, ?, ?)");
  await familyInsert.run('Pat Zzyszewski', 'last-family-parent', 'parent', familyId, 1);
  await familyInsert.run('Alex Zzyszewski', 'last-family-kid-1', 'student', familyId, 0);
  await familyInsert.run('Bailey Zzyszewski', 'last-family-kid-2', 'student', familyId, 0);
  await familyInsert.run('Casey Zzyszewski', 'last-family-kid-3', 'student', familyId, 0);
  // Sorted by the LAST word of the name, so "Zzzzyx" (not "Last") is what
  // has to sort after "Zzyszewski". Confirms page 2 starts cleanly right
  // after the family, not mid-family and not skipping/duplicating anyone.
  await soloInsert.run('Last Zzzzyx', 'last-family-solo-last');

  const page1 = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(page1.status, 200);
  // All 4 Zzyszewskis land on page 1 together, growing it past the usual
  // 50 rather than splitting the family at member 50 - checked as actual
  // roster rows (member-row-name-link), not a raw text count, since the
  // family name can also appear elsewhere on the page (a Family filter
  // option, etc).
  assert.match(page1.text, /member-row-name-link"[^>]*>Pat Zzyszewski/);
  assert.match(page1.text, /member-row-name-link"[^>]*>Alex Zzyszewski/, 'every family member rendered, not just the first 2');
  assert.match(page1.text, /member-row-name-link"[^>]*>Bailey Zzyszewski/);
  assert.match(page1.text, /member-row-name-link"[^>]*>Casey Zzyszewski/);
  assert.match(page1.text, /Showing 1&ndash;52 of 53/, 'page 1 grew to 52 (48 solo + 4 family) to keep the family whole');
  // The accordion toggle's own "+N more" count must match reality - with
  // the full family actually present on this page, it correctly says 3
  // more (4 total - the primary parent shown by default).
  assert.match(page1.text, /Show 3 more family members/);

  const page2 = await request(app).get('/admin/members?page=2').set('Cookie', cookie);
  assert.equal(page2.status, 200);
  assert.doesNotMatch(page2.text, /member-row-name-link"[^>]*>[^<]*Zzyszewski/, 'none of the family should spill onto page 2');
  assert.match(page2.text, /member-row-name-link"[^>]*>Last Zzzzyx/);
  assert.match(page2.text, /Showing 53&ndash;53 of 53/);
});

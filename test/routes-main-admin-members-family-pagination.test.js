// A real bug report: "Main admin portal and co-op admin portal, member
// list. The drop down for the last family on the page is sometimes
// putting part of the family on the next page. Families should stay
// together on the member list. Each member list page doesn't have to be
// an exact number of members." See test/routes-members-family-
// pagination.test.js's own header comment for the full root-cause
// explanation - this covers the exact same fix on Main Admin's own
// Members list (/main-admin/members), separately, since the two lists
// are two different routes/views sharing the one utils/pagination.js fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-family-pagination-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-family-pagination-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

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

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Main Admin Members list keeps the last family on a page together instead of splitting it across pages', async () => {
  const cookie = await loginAsMainAdmin();

  // Same setup as the Co-op Admin version of this test - 48 solo members
  // sorting (by last name) well before "Zzyszewski", a 4-person
  // Zzyszewski family right at the default 50-per-page boundary, and one
  // more solo member sorting after the family.
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
  await soloInsert.run('Last Zzzzyx', 'last-family-solo-last');

  const page1 = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(page1.status, 200);
  assert.match(page1.text, /member-row-name-link"[^>]*>Pat Zzyszewski/);
  assert.match(page1.text, /member-row-name-link"[^>]*>Alex Zzyszewski/, 'every family member rendered, not just the first 2');
  assert.match(page1.text, /member-row-name-link"[^>]*>Bailey Zzyszewski/);
  assert.match(page1.text, /member-row-name-link"[^>]*>Casey Zzyszewski/);
  assert.match(page1.text, /Showing 1&ndash;52 of 53/, 'page 1 grew to 52 (48 solo + 4 family) to keep the family whole');
  assert.match(page1.text, /Show 3 more family members/);

  const page2 = await request(app).get('/main-admin/members?page=2').set('Cookie', cookie);
  assert.equal(page2.status, 200);
  assert.doesNotMatch(page2.text, /member-row-name-link"[^>]*>[^<]*Zzyszewski/, 'none of the family should spill onto page 2');
  assert.match(page2.text, /member-row-name-link"[^>]*>Last Zzzzyx/);
  assert.match(page2.text, /Showing 53&ndash;53 of 53/);
});

// Real request: "main admin portal. members. when you click on a parent,
// then click edit profile button, it will allow you to add parents and
// students just like the membership form when people register to be a
// member." A member's Edit Profile page (main-admin-member-edit.ejs) now
// has a "+ Add Parent or Student" link that opens the SAME shared family-
// intake form every other "add a member" entry point already uses
// (routes/main-admin-members.js's own /new, shared via views/member-
// intake-form.ejs), just pre-locked to that member's own family
// (familyId query param) and pointed back at the Edit Profile page when
// done (returnTo), instead of a separate, duplicated form.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-add-family-member-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-add-family-member-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('Edit Profile page links to "+ Add Parent or Student" for a member with a family, scoped to that family', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Add Family Member Test')").run()).lastInsertRowid;
  const memberId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent) VALUES ('Existing Parent', 'add-fam-member-parent', 'parent', ?, 1)").run(familyId)
  ).lastInsertRowid;

  const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    new RegExp(`href="/main-admin/members/new\\?familyId=${familyId}&returnTo=%2Fmain-admin%2Fmembers%2F${memberId}%2Fedit"`)
  );
  assert.match(res.text, /\+ Add Parent or Student/);
});

test('a member with no family yet gets a hint instead of the add-family-member link', async () => {
  const cookie = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Familyless Member', 'add-fam-member-none', 'parent')").run()).lastInsertRowid;

  const res = await request(app).get(`/main-admin/members/${memberId}/edit`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /\+ Add Parent or Student/);
  assert.match(res.text, /Choose or add a family above and save/);
});

test('GET /new?familyId=...&returnTo=... locks the family and renders hidden familyId/returnTo fields', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Locked Family')").run()).lastInsertRowid;

  const res = await request(app)
    .get(`/main-admin/members/new?familyId=${familyId}&returnTo=${encodeURIComponent('/main-admin/members/999/edit')}`)
    .set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Adding to <strong>The Locked Family Family<\/strong>/);
  assert.match(res.text, new RegExp(`name="familyId" value="${familyId}"`));
  assert.match(res.text, /name="returnTo" value="\/main-admin\/members\/999\/edit"/);
  assert.doesNotMatch(res.text, /Choose from available families/, 'the open family picker should not render when locked to a preset family');
});

test('POST /new with a locked familyId adds the new members to that family and redirects to returnTo', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members/new').set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Redirect Family')").run()).lastInsertRowid;
  const returnTo = '/main-admin/members/123/edit';

  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      familyId: String(familyId),
      presetFamilyId: String(familyId),
      returnTo,
      'parents[0][name]': 'New Parent Added Via Family',
      'parents[0][isPrimaryParent]': '1',
      'children[0][name]': 'New Kid Added Via Family',
      _csrf: csrfToken,
    });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), new RegExp(`^${returnTo}\\?notice=Added 2 member\\(s\\)\\.$`));

  const rows = await db.prepare('SELECT name, member_type FROM members WHERE family_id = ? ORDER BY member_type').all(familyId);
  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    ['New Kid Added Via Family', 'New Parent Added Via Family']
  );
});

test('returnTo is rejected when it is not a same-site path (open-redirect guard)', async () => {
  const cookie = await loginAsMainAdmin();
  const res = await request(app)
    .get('/main-admin/members/new?returnTo=' + encodeURIComponent('https://evil.example.com/phish'))
    .set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /evil\.example\.com/);
  assert.match(res.text, /href="\/main-admin\/members">&larr; Members<\/a>/, 'backHref should fall back to the normal Members list');
});

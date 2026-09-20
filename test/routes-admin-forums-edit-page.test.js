// Coverage for a real request thread on the chat group Edit page:
// "edit chat group popup, description should be stacked above the
// description box... Lock the chat group should be under edit, not on
// the front of the chat group card. There should also be an archive
// button," and: "edit chat group. This popup should also show a full
// list of all members... a column next to each name with checkboxes
// that is called email notifications... Instead of a popup edit chat to
// be a page with save button."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-forums-edit-page-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-forums-edit-page-test-uploads-${process.pid}`);
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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createCategory(admin, name) {
  await request(app).post('/main-admin/forums').set('Cookie', admin.cookie).type('form').send({ name, scope: 'general', _csrf: admin.csrfToken });
  return db.prepare('SELECT * FROM forum_categories WHERE name = ?').get(name);
}

test('Edit page: Lock/Unlock now lives here, not on the chat group card', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Lock Edit Test Chat');

  const listPage = await request(app).get('/main-admin/forums?tab=new').set('Cookie', admin.cookie);
  assert.doesNotMatch(listPage.text, new RegExp(`/main-admin/forums/${category.id}/lock`));

  const editPage = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, new RegExp(`action="/main-admin/forums/${category.id}/lock"`));

  const lockRes = await request(app).post(`/main-admin/forums/${category.id}/lock`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.match(lockRes.headers.location, new RegExp(`/main-admin/forums/${category.id}/edit`));
  const locked = await db.prepare('SELECT is_locked FROM forum_categories WHERE id = ?').get(category.id);
  assert.equal(locked.is_locked, 1);

  const editPageAfter = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPageAfter.text, new RegExp(`action="/main-admin/forums/${category.id}/unlock"`));
});

test('Edit page: Archive/Unarchive toggles status without deleting the category', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Archive Edit Test Chat');

  const archiveRes = await request(app).post(`/main-admin/forums/${category.id}/archive`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(archiveRes.status, 302);
  let updated = await db.prepare('SELECT status FROM forum_categories WHERE id = ?').get(category.id);
  assert.equal(updated.status, 'archived');

  const listPage = await request(app).get('/main-admin/forums?tab=new').set('Cookie', admin.cookie);
  assert.match(listPage.text, /badge-pill-gray">Archived</);

  const unarchiveRes = await request(app).post(`/main-admin/forums/${category.id}/unarchive`).set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
  assert.equal(unarchiveRes.status, 302);
  updated = await db.prepare('SELECT status FROM forum_categories WHERE id = ?').get(category.id);
  assert.equal(updated.status, 'active');
});

test('Edit page: full member list with a per-member Email Notifications checkbox, saved via the settings form', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Notify Edit Test Chat');

  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Notify Test Family')).lastInsertRowid;
  const parent = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'parent', ?, 1, 1)")
    .run('Notify Test Parent', 'NTF-P1', familyId);
  const child = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES (?, ?, 'student', ?, 0, 1)")
    .run('Notify Test Child', 'NTF-C1', familyId);

  const editPage = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /Email Notifications/);
  assert.match(editPage.text, /Notify Test Parent/);
  assert.match(editPage.text, new RegExp(`value="${parent.lastInsertRowid}"`));
  assert.match(editPage.text, new RegExp(`value="${child.lastInsertRowid}"`));
  // The child is a non-head family member, so their row starts collapsed
  // behind the family's own accordion toggle.
  assert.match(editPage.text, /data-family-member="1"/);

  const saveRes = await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: category.name, notifyMemberIds: String(parent.lastInsertRowid), _csrf: admin.csrfToken });
  assert.match(saveRes.headers.location, new RegExp(`/main-admin/forums/${category.id}/edit`));

  const subscribed = await db.prepare('SELECT member_id FROM forum_category_subscribers WHERE category_id = ?').all(category.id);
  assert.deepEqual(subscribed.map((r) => r.member_id), [parent.lastInsertRowid]);

  const editPageAfter = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  const parentCheckbox = new RegExp(`value="${parent.lastInsertRowid}" checked`).exec(editPageAfter.text);
  assert.ok(parentCheckbox, 'the parent checkbox should stay checked after saving');
  assert.doesNotMatch(editPageAfter.text, new RegExp(`value="${child.lastInsertRowid}" checked`));
});

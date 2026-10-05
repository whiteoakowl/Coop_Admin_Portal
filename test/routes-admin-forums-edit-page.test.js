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

// A real request: "allow comments the check box should be in the left
// column, first sentence starts on the same row as the check box clean.
// Moderator choice should be under all comment selection." - Allow
// Comments and Secure sit in the same grid row (left/right columns), and
// Member to Moderate is the very next field after that row.
test('Edit page: Allow Comments (left) and Secure (right) share one row, Moderator comes directly after', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Layout Order Test Chat');

  const editPage = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.equal(editPage.status, 200);

  const allowCommentsIdx = editPage.text.indexOf('Allow comments');
  const secureIdx = editPage.text.indexOf('Secure - if you only want certain families');
  const moderatorIdx = editPage.text.indexOf('Member to Moderate');
  assert.ok(allowCommentsIdx > -1 && secureIdx > -1 && moderatorIdx > -1);
  assert.ok(allowCommentsIdx < secureIdx, 'Allow comments should come before Secure (left column first)');
  assert.ok(secureIdx < moderatorIdx, 'Moderator should come directly after the Allow Comments/Secure row');

  // Allow comments: checkbox then its label text on the same row/line,
  // not a separate heading above a pill wrapper.
  assert.match(editPage.text, /<label class="checkbox-option">\s*<input type="checkbox" name="allowComments"[^>]*\/>\s*Allow comments/);
});

// A real request: "sections choices should be in a clean dropdown menu
// with check boxes" - same checkbox-dropdown widget as Events' Lock by
// Age/Grade, not the old wall of plain checkboxes.
test('Edit page: Sections render as a checkbox-dropdown, not a plain checkbox wall', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Sections Dropdown Test Chat');
  await db.prepare("INSERT INTO sections (name) VALUES ('North')").run();

  const editPage = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /class="multi-select-checkbox"/);
  assert.match(editPage.text, /data-multi-select-placeholder="All sections"/);
  assert.match(editPage.text, /<input type="checkbox" name="sectionIds" value="\d+"[^>]*\/>\s*North/);
});

// A real request: "another check box column for secure... Check box
// Secure - If you only want certain families to be able to access this
// category, check this box AND select which families can access it
// below."
test('Secure categories: checking Secure with families selected restricts access to only those families', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Secure Family Test Chat');

  const allowedFamilyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Secure Allowed Family')).lastInsertRowid;
  const blockedFamilyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Secure Blocked Family')).lastInsertRowid;

  const editPage = await request(app).get(`/main-admin/forums/${category.id}/edit`).set('Cookie', admin.cookie);
  assert.match(editPage.text, /name="isSecure"/);
  assert.match(editPage.text, new RegExp(`name="familyIds" value="${allowedFamilyId}"`));

  const saveRes = await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: category.name, isSecure: 'on', familyIds: String(allowedFamilyId), _csrf: admin.csrfToken });
  assert.equal(saveRes.status, 302);

  const updated = await db.prepare('SELECT is_secure FROM forum_categories WHERE id = ?').get(category.id);
  assert.equal(Number(updated.is_secure), 1);

  const forums = require('../utils/forums');
  const allowedFamilyIds = await forums.allowedFamilyIds(category.id);
  assert.deepEqual([...allowedFamilyIds], [allowedFamilyId]);

  const fullCategory = await db.prepare('SELECT * FROM forum_categories WHERE id = ?').get(category.id);
  const allowedFamily = [{ id: 1, family_id: allowedFamilyId }];
  const blockedFamily = [{ id: 2, family_id: blockedFamilyId }];
  assert.equal(await forums.canAccessCategory(fullCategory, allowedFamily), true);
  assert.equal(await forums.canAccessCategory(fullCategory, blockedFamily), false);
});

test('Secure categories: checking Secure with no families selected blocks everyone', async () => {
  const admin = await loginAsMainAdmin();
  const category = await createCategory(admin, 'Secure No Families Test Chat');
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Secure Lockout Family')).lastInsertRowid;

  const saveRes = await request(app)
    .post(`/main-admin/forums/${category.id}/settings`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: category.name, isSecure: 'on', _csrf: admin.csrfToken });
  assert.equal(saveRes.status, 302);

  const forums = require('../utils/forums');
  const fullCategory = await db.prepare('SELECT * FROM forum_categories WHERE id = ?').get(category.id);
  const anyFamily = [{ id: 1, family_id: familyId }];
  assert.equal(await forums.canAccessCategory(fullCategory, anyFamily), false);
});

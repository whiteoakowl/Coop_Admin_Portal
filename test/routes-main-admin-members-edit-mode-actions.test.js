// Coverage for a real request: "main admin, edit button, actions drop
// down should also have delete. also add select none and check box next
// to select all." The Members tab's own "Actions" dropdown used to only
// offer Archive (Delete was deliberately dropped by an earlier request,
// then asked back by this one); Select All also had a "Select None"
// companion checkbox.
//
// A later real request replaced that dropdown: "Add a column of check
// boxes in the first column of every member... Add a bulk action
// button... it will have a drop down menu asking if you want to delete
// the members, email them, text them." The old "Edit Member List"
// toggle and the separate Select None checkbox were both removed -
// checkboxes are permanently visible, and a single "Bulk Action"
// dropdown (Archive/Delete/Email/Text) auto-submitted on pick.
//
// A further real request replaced THAT with a real "Bulk Edit" button:
// "allows you to select 1 or multiple members and add them to a
// section, portal, family, delete. Archive, text or email." One button
// now opens a dialog (#bulk-edit-dialog) with an action <select> and,
// for Add to Section(s)/Portal(s)/Family, a contextual sub-picker -
// Apply arms the shared #members-select-form and submits it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-edit-mode-actions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-edit-mode-actions-test-uploads-${process.pid}`);
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

test('Members tab: Select All and a Bulk Edit button/dialog are permanently visible, with no Edit toggle, Select None, or the old dropdown', async () => {
  const cookie = await loginAsMainAdmin();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Always Visible Checkbox Test', 'avc-test-1', 'student', 1)").run();
  const res = await request(app).get('/main-admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // A real request: "Import, export, pdf and print icons next to bulk
  // edit button on the same row" added a second class
  // (.main-admin-members-btn-row) to this div for its own shrink-font
  // styling - tolerant of that extra class instead of requiring the
  // bare original.
  const controlsMatch = /<div class="class-schedule-archive-controls[^"]*">([\s\S]*?)<\/div>\s*<\/div>/.exec(res.text);
  assert.ok(controlsMatch, 'expected the always-visible Select All/Bulk Edit controls block');
  const controls = controlsMatch[1];

  assert.match(controls, /data-select-all-for="members-select-form"/);
  // A real request: "Put bulk edit button next to filter button and
  // shrink the search bar" moved #bulk-edit-btn out of this div and into
  // .members-search-filter-row instead - still present on the page, just
  // not inside this particular controls block any more.
  assert.match(res.text, /class="members-search-filter-row[^"]*">[\s\S]*?id="bulk-edit-btn"/, 'expected Bulk Edit in the search-filter row');
  assert.doesNotMatch(controls, /data-select-none-for/, 'Select None was removed - unchecking Select All already clears everyone');
  assert.doesNotMatch(res.text, /Select None/);
  assert.doesNotMatch(res.text, /Edit Member List/, 'the old Edit Member List toggle was replaced by permanently-visible controls');
  assert.doesNotMatch(res.text, /data-archive-toggle="members-select-form"/);
  assert.doesNotMatch(res.text, /data-bulk-action-select/, 'the old simple dropdown was replaced by the Bulk Edit dialog');

  // The dialog itself: an action select plus Add to Section(s)/
  // Portal(s)/Family sub-pickers and the Archive/Delete/Email/Text
  // options.
  const dialogMatch = /<dialog id="bulk-edit-dialog"[^>]*>([\s\S]*?)<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'expected the Bulk Edit dialog');
  const dialog = dialogMatch[1];
  assert.match(dialog, /<option value="sections">Add to Section\(s\)<\/option>/);
  assert.match(dialog, /<option value="roles">Add to Portal\(s\)<\/option>/);
  assert.match(dialog, /<option value="family">Add to Family<\/option>/);
  assert.match(dialog, /<option value="archive">Archive<\/option>/);
  assert.match(dialog, /<option value="delete">Delete<\/option>/);
  assert.match(dialog, /<option value="email">Email<\/option>/);
  assert.match(dialog, /<option value="text">Text<\/option>/);
  assert.match(dialog, /id="bulk-edit-sections-fields" hidden/);
  assert.match(dialog, /id="bulk-edit-roles-fields" hidden/);
  assert.match(dialog, /id="bulk-edit-family-fields" hidden/);
  assert.match(dialog, /name="familyId" form="members-select-form"/);
  assert.match(dialog, /id="bulk-edit-apply-btn" disabled/);

  // No more hidden-until-Edit-mode checkbox - every member row's own
  // checkbox is in the markup without a `hidden` attribute.
  assert.match(res.text, /class="archive-select-checkbox no-print" aria-label="[^"]*" \/>/);
});

test('the Bulk Edit dialog Delete option (POST /bulk-delete) actually deletes the selected member(s)', async () => {
  const cookie = await loginAsMainAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Dropdown Delete Test', 'ddt-1', 'student', 1) RETURNING id").get()).id;
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  await request(app).post('/main-admin/members/bulk-delete').set('Cookie', cookie).type('form').send({ memberIds: String(memberId), _csrf: csrf });

  const row = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  assert.equal(row, undefined, 'the member should be gone after bulk-delete');
});

// A real request: the Members page's own Bulk Edit > Email/Text needs
// to land on the same compose screen Communication > Email/Text's own
// candidate list does, with the selected members pre-filled - see
// utils/emailComposer.js's own resolveRecipients().
test('Bulk Edit > Email posts memberIds straight to the compose screen with that member pre-filled', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Bulk Email Family') RETURNING id").get()).id;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Bulk Email Member', 'bulk-email-member', 'parent', ?, 1) RETURNING id")
      .get(familyId)
  ).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, 'bulk-email-member@example.com', 'x', 'active', now_text()) RETURNING id")
      .get(memberId)
  ).id;

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const res = await request(app)
    .post('/main-admin/announcements/email/compose')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(memberId), _csrf: csrf });

  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`name="recipientIds" value="${accountId}"`));
  assert.match(res.text, /Bulk Email Member/);
});

// A real request: "bulk edit button allows you to select 1 or multiple
// members and add them to a section, portal, family" - additive (not a
// full replace), so a member's existing sections/roles/family are left
// alone, just added to.
test('Bulk Edit > Add to Section(s) (POST /bulk-add-sections) adds every selected member to every checked section, additively', async () => {
  const cookie = await loginAsMainAdmin();
  const sectionIdKeep = (await db.prepare("INSERT INTO sections (name) VALUES ('Bulk Edit Keep Section') RETURNING id").get()).id;
  const sectionIdAdd = (await db.prepare("INSERT INTO sections (name) VALUES ('Bulk Edit Add Section') RETURNING id").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Bulk Section Member', 'bulk-section-member', 'student', 1) RETURNING id").get()).id;
  await db.prepare('INSERT INTO member_sections (member_id, section_id) VALUES (?, ?)').run(memberId, sectionIdKeep);

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const res = await request(app)
    .post('/main-admin/members/bulk-add-sections')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(memberId), sectionIds: String(sectionIdAdd), _csrf: csrf });
  assert.equal(res.status, 302);

  const rows = await db.prepare('SELECT section_id FROM member_sections WHERE member_id = ? ORDER BY section_id').all(memberId);
  const sectionIds = rows.map((r) => r.section_id).sort((a, b) => a - b);
  assert.deepEqual(sectionIds.sort((a, b) => a - b), [sectionIdKeep, sectionIdAdd].sort((a, b) => a - b), 'the pre-existing section must still be there alongside the newly added one');
});

test('Bulk Edit > Add to Portal(s) (POST /bulk-add-roles) grants the role to a member with an account, and skips one without', async () => {
  const cookie = await loginAsMainAdmin();
  const roleId = (await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get()).id;
  const memberWithAccountId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Bulk Role With Account', 'bulk-role-with-account', 'parent', 1) RETURNING id").get()).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'bulk-role-with-account@example.com', 'x', 'active') RETURNING id")
      .get(memberWithAccountId)
  ).id;
  const memberNoAccountId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Bulk Role No Account', 'bulk-role-no-account', 'parent', 1) RETURNING id").get()).id;

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const res = await request(app)
    .post('/main-admin/members/bulk-add-roles')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: [String(memberWithAccountId), String(memberNoAccountId)], roleIds: String(roleId), _csrf: csrf });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /Added%201%20portal\(s\)/);
  assert.match(res.headers.location, /1%20skipped/);

  const granted = await db.prepare('SELECT 1 AS x FROM member_account_roles WHERE member_account_id = ? AND role_id = ?').get(accountId, roleId);
  assert.ok(granted, 'the member with a portal account should have been granted the role');
});

test('Bulk Edit > Add to Family (POST /bulk-add-family) sets family_id for every selected member', async () => {
  const cookie = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Bulk Add Family Target') RETURNING id").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Bulk Family Member', 'bulk-family-member', 'student', 1) RETURNING id").get()).id;

  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const res = await request(app)
    .post('/main-admin/members/bulk-add-family')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(memberId), familyId: String(familyId), _csrf: csrf });
  assert.equal(res.status, 302);

  const row = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  assert.equal(Number(row.family_id), familyId);
});

test('the old Edit Permissions route is gone', async () => {
  const cookie = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const csrf = extractCsrf(page.text);

  const res = await request(app).post('/main-admin/members/bulk-permissions').set('Cookie', cookie).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 404);
});

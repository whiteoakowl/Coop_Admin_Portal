// Route-level coverage for the Members page's Edit mode: bulk Delete
// Selected and the Edit Families dialog's rename/delete. "Delete" is the
// existing permanent single-member delete, extended to a batch. Deleting a
// family (families.id has ON DELETE SET NULL on members.family_id) only
// ungroups its members, never deletes them. Archive/Restore Selected used
// to live here too, but a real request removed the whole Archive feature
// from Co-op Admin's own Members page ("remove member archive page, it is
// not needed on co-op admin, only main admin") - that coverage belongs with
// Main Admin's own equivalent routes (routes/main-admin-members.js), not
// here; see the two tests below confirming it's gone from this side.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `members-bulk-actions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `members-bulk-actions-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('GET /admin/members only ever shows active members - ?archived=1 does nothing now (Archive is Main Admin-only)', async () => {
  const { cookie } = await loginAsAdmin();
  const activeId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Active Member', 'active-member', 'student', 1) RETURNING id").get()).id;
  const archivedId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Archived Member', 'archived-member', 'student', 0) RETURNING id").get()).id;
  // Co-op Admin's own Members list only shows students registered for
  // classes (real request: "members only appear on the member list for
  // co-op admin portal if they are registered for classes"), so the
  // active fixture needs a class_enrollments row to show up here at all.
  const fixtureClassId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Bulk Actions Fixture Class') RETURNING id").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(fixtureClassId, activeId);

  const activeRes = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.match(activeRes.text, /Active Member/);
  assert.doesNotMatch(activeRes.text, /Archived Member/);

  const archivedParamRes = await request(app).get('/admin/members?archived=1').set('Cookie', cookie);
  assert.match(archivedParamRes.text, /Active Member/, '?archived=1 is a no-op now - still shows active members');
  assert.doesNotMatch(archivedParamRes.text, /Archived Member/, 'an archived member never shows on this page anymore');
  assert.doesNotMatch(archivedParamRes.text, /Archive Selected/, 'the Archive Selected button is gone from Co-op Admin');
  assert.doesNotMatch(archivedParamRes.text, /Restore Selected/, 'the Restore Selected button is gone from Co-op Admin');

  await db.prepare('DELETE FROM members WHERE id IN (?, ?)').run(activeId, archivedId);
});

test('POST /admin/members/bulk-archive and bulk-unarchive no longer exist on Co-op Admin', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Not Archivable', 'not-archivable', 'student') RETURNING id").get()).id;

  for (const action of ['bulk-archive', 'bulk-unarchive']) {
    const res = await request(app)
      .post(`/admin/members/${action}`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken, memberIds: [String(id)] });
    assert.equal(res.status, 404, `${action} should no longer be a route on Co-op Admin`);
  }

  const row = await db.prepare('SELECT active FROM members WHERE id = ?').get(id);
  assert.equal(Number(row.active), 1, 'the member must be untouched');
  await db.prepare('DELETE FROM members WHERE id = ?').run(id);
});

test('POST /admin/members/bulk-delete permanently removes every selected member, leaving others untouched', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id1 = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Delete Bulk One', 'delete-bulk-1', 'student') RETURNING id").get()).id;
  const id2 = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Delete Bulk Two', 'delete-bulk-2', 'student') RETURNING id").get()).id;
  const idUnselected = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Delete Bulk Untouched', 'delete-bulk-3', 'student') RETURNING id").get()).id;

  const res = await request(app)
    .post('/admin/members/bulk-delete')
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, memberIds: [String(id1), String(id2)] });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Deleted%202%20member/);

  assert.equal(await db.prepare('SELECT id FROM members WHERE id = ?').get(id1), undefined);
  assert.equal(await db.prepare('SELECT id FROM members WHERE id = ?').get(id2), undefined);
  assert.notEqual(await db.prepare('SELECT id FROM members WHERE id = ?').get(idUnselected), undefined, 'a member not in the selection must survive');
});

test('bulk-delete with no memberIds redirects back with an error, changing nothing', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Selection Member', 'no-selection-member', 'student') RETURNING id").get()).id;

  const res = await request(app).post('/admin/members/bulk-delete').set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=Select/);

  const row = await db.prepare('SELECT active FROM members WHERE id = ?').get(id);
  assert.ok(row, 'the member must not have been deleted');
});

// A real request: "Add a column of check boxes in the first column of
// every member. In the title row of this column is a single check box,
// selecting the box will select all and deselecting the box will
// uncheck all. Add a bulk action button to this page. When you select
// members and then click bulk action it will have a drop down menu
// asking if you want to delete the members, email them, text them."
// Replaces the old "Edit" toggle (checkboxes/the Select All+Delete row
// used to be hidden until that was clicked) - permanently visible now,
// same shape Main Admin's own Members page uses, plus new Email/Text
// options on the renamed "Bulk Action" dropdown.
test('Co-op Admin Members: Select All and the Bulk Action dropdown (Delete/Email/Text) are permanently visible, no Edit toggle', async () => {
  const { cookie } = await loginAsAdmin();
  await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Coop Always Visible Checkbox', 'coop-avc-test-1', 'student', 1)").run();
  const fixtureClassId = (await db.prepare("INSERT INTO classes (day, hour_position, class_name) VALUES ('monday', 1, 'Coop Bulk UI Fixture Class') RETURNING id").get()).id;
  const memberId = (await db.prepare("SELECT id FROM members WHERE barcode = 'coop-avc-test-1'").get()).id;
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(fixtureClassId, memberId);

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(page.status, 200);

  assert.doesNotMatch(page.text, />Edit</, 'the old Edit toggle button is gone');
  assert.doesNotMatch(page.text, /data-archive-toggle="members-bulk-form"/);
  assert.doesNotMatch(page.text, /Delete Selected/, 'the old standalone Delete Selected button is gone');

  const controlsMatch = /<div class="class-schedule-archive-controls">([\s\S]*?)<\/div>/.exec(page.text);
  assert.ok(controlsMatch, 'expected the always-visible Select All/Bulk Action controls block');
  const controls = controlsMatch[1];
  assert.match(controls, /data-select-all-for="members-bulk-form"/);
  assert.match(controls, />Bulk Action</);
  assert.match(controls, /value="delete"[\s\S]*?data-bulk-action="\/admin\/members\/bulk-delete"/);
  assert.match(controls, /value="email"[\s\S]*?data-bulk-action="\/admin\/announcements\/email\/compose"/);
  assert.match(controls, /value="text"[\s\S]*?data-bulk-action="\/admin\/announcements\/text\/compose"/);
  assert.doesNotMatch(controls, />Archive</, 'no Archive option on Co-op Admin');

  // The per-row checkbox itself is no longer hidden.
  const checkboxMatch = new RegExp(`name="memberIds" value="${memberId}" form="members-bulk-form" class="archive-select-checkbox no-print" aria-label="[^"]*" />`).exec(page.text);
  assert.ok(checkboxMatch, 'expected a visible (not hidden) checkbox for the fixture member');
});

test('Co-op Admin Members: Bulk Action > Text posts memberIds straight to the compose screen with that member pre-filled', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Coop Bulk Text Member', 'coop-bulk-text-member', 'student', 1) RETURNING id")
      .get()
  ).id;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, 'coop-bulk-text-member@example.com', 'x', 'active', now_text()) RETURNING id")
      .get(memberId)
  ).id;

  const res = await request(app)
    .post('/admin/announcements/text/compose')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(memberId), _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.match(res.text, new RegExp(`name="recipientIds" value="${accountId}"`));
  assert.match(res.text, /Coop Bulk Text Member/);
});

// Family rename/delete (POST /admin/members/families/:id/rename,
// /admin/members/families/:id/delete) used to live here too, but a real
// request removed the whole Manage Families dialog from Co-op Admin's
// own Members page ("this is only done on main admin portal") - that
// coverage belongs with Main Admin's own equivalent routes now
// (routes/main-admin-members.js), not here. POST /admin/members/
// families/new stays (and is still covered elsewhere): the Add/Edit
// Member form's own "+ Add New Family" inline dialog still needs it.
test('Co-op Admin Members: the Manage Families dialog/button is gone, and its rename/delete routes no longer exist', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Removed Feature Family') RETURNING id").get()).id;

  const page = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.doesNotMatch(page.text, /Manage Families/);
  assert.doesNotMatch(page.text, /manage-families-dialog/);
  assert.doesNotMatch(page.text, /edit-families\.js/);

  const renameRes = await request(app)
    .post(`/admin/members/families/${familyId}/rename`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, name: 'Should Not Work' });
  assert.equal(renameRes.status, 404);

  const deleteRes = await request(app).post(`/admin/members/families/${familyId}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(deleteRes.status, 404);

  const row = await db.prepare('SELECT name FROM families WHERE id = ?').get(familyId);
  assert.equal(row.name, 'Removed Feature Family', 'the family should be untouched since neither route exists anymore');
});

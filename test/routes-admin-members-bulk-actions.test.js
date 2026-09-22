// Route-level coverage for the Members page's Edit mode: bulk Delete/
// Archive/Restore Selected and the Edit Families dialog's rename/delete.
// "Archive" sets active = 0 (a soft, undoable removal from the default
// list - see routes/admin-members.js's GET /members comment); "Delete" is
// the existing permanent single-member delete, extended to a batch.
// Deleting a family (families.id has ON DELETE SET NULL on
// members.family_id) only ungroups its members, never deletes them.
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

test('GET /admin/members only shows active members by default, and only archived ones with ?archived=1', async () => {
  const { cookie } = await loginAsAdmin();
  const activeId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Active Member', 'active-member', 'student', 1) RETURNING id").get()).id;
  const archivedId = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Archived Member', 'archived-member', 'student', 0) RETURNING id").get()).id;

  const activeRes = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.match(activeRes.text, /Active Member/);
  assert.doesNotMatch(activeRes.text, /Archived Member/);

  const archivedRes = await request(app).get('/admin/members?archived=1').set('Cookie', cookie);
  assert.doesNotMatch(archivedRes.text, /Active Member/);
  assert.match(archivedRes.text, /Archived Member/);

  await db.prepare('DELETE FROM members WHERE id IN (?, ?)').run(activeId, archivedId);
});

test('POST /admin/members/bulk-archive sets active = 0 for every selected member, leaving others untouched', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id1 = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Bulk One', 'archive-bulk-1', 'student') RETURNING id").get()).id;
  const id2 = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Bulk Two', 'archive-bulk-2', 'student') RETURNING id").get()).id;
  const idUnselected = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Bulk Untouched', 'archive-bulk-3', 'student') RETURNING id").get()).id;

  const res = await request(app)
    .post('/admin/members/bulk-archive')
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, memberIds: [String(id1), String(id2)] });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Archived%202%20member/);

  const row1 = await db.prepare('SELECT active FROM members WHERE id = ?').get(id1);
  const row2 = await db.prepare('SELECT active FROM members WHERE id = ?').get(id2);
  const rowUntouched = await db.prepare('SELECT active FROM members WHERE id = ?').get(idUnselected);
  assert.equal(Number(row1.active), 0);
  assert.equal(Number(row2.active), 0);
  assert.equal(Number(rowUntouched.active), 1, 'a member not in the selection must stay active');
});

test('POST /admin/members/bulk-unarchive restores selected members back to active', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id = (await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Restore Bulk One', 'restore-bulk-1', 'student', 0) RETURNING id").get()).id;

  const res = await request(app)
    .post('/admin/members/bulk-unarchive')
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, memberIds: [String(id)] });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Restored%201%20member/);

  const row = await db.prepare('SELECT active FROM members WHERE id = ?').get(id);
  assert.equal(Number(row.active), 1);
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

test('bulk-delete/bulk-archive/bulk-unarchive with no memberIds redirects back with an error, changing nothing', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const id = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Selection Member', 'no-selection-member', 'student') RETURNING id").get()).id;

  for (const action of ['bulk-delete', 'bulk-archive', 'bulk-unarchive']) {
    const res = await request(app).post(`/admin/members/${action}`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /error=Select/);
  }

  const row = await db.prepare('SELECT active FROM members WHERE id = ?').get(id);
  assert.ok(row, 'the member must not have been deleted');
  assert.equal(Number(row.active), 1, 'the member must not have been archived');
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

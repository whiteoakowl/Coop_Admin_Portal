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
  assert.match(archivedRes.text, /class="view-tab active"[^>]*>Archived</);

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

test('POST /admin/members/families/:id/rename changes the family name', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Original Family Name') RETURNING id").get()).id;

  const res = await request(app)
    .post(`/admin/members/families/${familyId}/rename`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, name: 'Renamed Family Name' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Family%20renamed/);

  const row = await db.prepare('SELECT name FROM families WHERE id = ?').get(familyId);
  assert.equal(row.name, 'Renamed Family Name');
});

test('POST /admin/members/families/:id/rename rejects a name clashing with another family', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await db.prepare("INSERT INTO families (name) VALUES ('Existing Family')").run();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Clash Target Family') RETURNING id").get()).id;

  const res = await request(app)
    .post(`/admin/members/families/${familyId}/rename`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, name: 'Existing Family' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /error=/);

  const row = await db.prepare('SELECT name FROM families WHERE id = ?').get(familyId);
  assert.equal(row.name, 'Clash Target Family', 'the name must be unchanged after a clash');
});

test('POST /admin/members/families/:id/delete removes the family but leaves its members intact, just ungrouped', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Family To Delete') RETURNING id").get()).id;
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type, family_id) VALUES ('Family Delete Member', 'family-delete-member', 'student', ?) RETURNING id").get(familyId)).id;

  const res = await request(app).post(`/admin/members/families/${familyId}/delete`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=Deleted%20/);

  assert.equal(await db.prepare('SELECT id FROM families WHERE id = ?').get(familyId), undefined, 'the family row itself should be gone');
  const member = await db.prepare('SELECT id, family_id FROM members WHERE id = ?').get(memberId);
  assert.ok(member, 'the member must not have been deleted');
  assert.equal(member.family_id, null, 'the member should just be ungrouped, not removed');
});

test('POST /admin/members/families/:id/delete returns JSON instead of redirecting when Accept: application/json is sent', async () => {
  // The Edit Families dialog's own Delete button (public/js/edit-families.js)
  // fetches this with Accept: application/json specifically so a real page
  // navigation never closes the dialog mid-cleanup - see routes/admin-
  // members.js's own comment.
  const { cookie, csrfToken } = await loginAsAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('JSON Delete Family') RETURNING id").get()).id;

  const res = await request(app)
    .post(`/admin/members/families/${familyId}/delete`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, familyId);
  assert.equal(res.body.name, 'JSON Delete Family');

  assert.equal(await db.prepare('SELECT id FROM families WHERE id = ?').get(familyId), undefined);
});

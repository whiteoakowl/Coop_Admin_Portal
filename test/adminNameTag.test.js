// Real coverage for the admin name tag feature (real request: "There
// should be an admin name tag in the design and print features. It will
// have the logo, name, barcode, id number and the admin position." plus
// "Add an optional dropdown menu for choosing an admin position."):
// member_type === 'admin' as a 3rd member type (the schema already
// reserved it), utils/adminPositions.js's Settings-managed position list,
// and utils/nameTagData.js/utils/nameTagBadge.js's admin badge support.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-name-tag-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-name-tag-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { DEFAULT_LAYOUTS, FIELDS_BY_TYPE } = require('../utils/nameTagBadge');
const { badgeDataForMember, badgeDataForMembers } = require('../utils/nameTagData');
const { addAdminPosition, listAdminPositions, syncMemberAdminPositions } = require('../utils/adminPositions');

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

test('DEFAULT_LAYOUTS.admin has logo, name, admin position, member ID, and barcode elements', () => {
  const elements = DEFAULT_LAYOUTS.admin.elements;
  assert.ok(elements.some((el) => el.type === 'image'), 'expected a logo image element');
  assert.ok(elements.some((el) => el.type === 'text' && el.field === 'name'), 'expected a name text element');
  assert.ok(elements.some((el) => el.type === 'text' && el.field === 'adminPosition'), 'expected an admin position text element');
  assert.ok(elements.some((el) => el.type === 'text' && el.field === 'memberCode'), 'expected a member ID text element');
  assert.ok(elements.some((el) => el.type === 'barcode'), 'expected a barcode element');
  assert.ok(FIELDS_BY_TYPE.admin.some((f) => f.field === 'adminPosition'), 'field picker should offer Admin Position');
});

test('utils/adminPositions.js: add/list/delete', async () => {
  await db.ready;
  const before = await listAdminPositions();
  await addAdminPosition('Treasurer');
  const after = await listAdminPositions();
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((p) => p.title === 'Treasurer'));

  // Duplicate add is a no-op, not an error or a duplicate row.
  await addAdminPosition('Treasurer');
  const afterDup = await listAdminPositions();
  assert.equal(afterDup.length, after.length);
});

test('badgeDataForMember/badgeDataForMembers: admin member gets name/adminPosition/memberCode/barcodeValue', async () => {
  await db.ready;
  const positionId = await addAdminPosition('Vice President');
  const adminId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Sam Admin', '000333', '000333', 'admin')").run()
  ).lastInsertRowid;
  await syncMemberAdminPositions(adminId, [positionId]);
  const admin = await db.prepare('SELECT * FROM members WHERE id = ?').get(adminId);

  const single = await badgeDataForMember(admin);
  assert.deepEqual(single.name, ['Sam', 'Admin']);
  // A real request: "ability to add unlimited admin positions to a member
  // profile" - adminPosition is now always an array (possibly more than
  // one title), stacked as multiple lines by the same array-value ->
  // multiline convention public/js/name-tag-render-core.js's textLines
  // already uses for setupCleanupDays/splitNameLines/gradeLevelLabel.
  assert.deepEqual(single.adminPosition, ['Vice President']);
  assert.equal(single.memberCode, 'ID#000333');
  assert.equal(single.barcodeValue, '000333');

  const batch = await badgeDataForMembers([admin]);
  assert.deepEqual(batch[adminId].adminPosition, ['Vice President']);

  // Two positions -> both titles, in the Settings-managed list's own
  // order, ready to render as two stacked lines.
  const presidentId = await addAdminPosition('President');
  await syncMemberAdminPositions(adminId, [positionId, presidentId]);
  const adminTwo = await db.prepare('SELECT * FROM members WHERE id = ?').get(adminId);
  assert.deepEqual((await badgeDataForMember(adminTwo)).adminPosition, ['Vice President', 'President']);

  // No position selected -> empty array, not an error.
  const bareId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('No Position Admin', '000334', '000334', 'admin')").run()
  ).lastInsertRowid;
  const bare = await db.prepare('SELECT * FROM members WHERE id = ?').get(bareId);
  assert.deepEqual((await badgeDataForMember(bare)).adminPosition, []);
});

test('Member form: creating an Admin member with positions, and the position picker offers Settings-managed positions', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await addAdminPosition('President');
  await addAdminPosition('Treasurer');
  const positions = await listAdminPositions();
  const presidentId = positions.find((p) => p.title === 'President').id;
  const treasurerId = positions.find((p) => p.title === 'Treasurer').id;

  // Admin member type (a leader who just needs a badge, no family/kids)
  // has no place on the family-intake form at /admin/members/new -
  // "there shouldn't be any lone admins/leaders, or single members," so
  // that form only ever creates parent/student rows. Turning an existing
  // member INTO an admin (with positions) is still done on their own
  // edit page (views/admin-member-edit.ejs via views/partials/member-
  // form-fields.ejs), which still carries the Admin/Student/Parent type
  // toggle - so create a plain family member first, then edit them.
  await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({
      newFamilyName: 'President Family',
      'parents[0][name]': 'Pat President',
      'children[0][name]': 'President Filler Kid',
      _csrf: csrfToken,
    });
  const created = await db.prepare("SELECT id FROM members WHERE name = 'Pat President'").get();

  const newPage = await request(app).get(`/admin/members/${created.id}/edit`).set('Cookie', cookie);
  assert.equal(newPage.status, 200);
  assert.match(newPage.text, /value="admin"/, 'expected an Admin option in the member type toggle');
  assert.match(newPage.text, /President/, 'expected the Settings-managed position in the picker');

  // A real request: "ability to add unlimited admin positions to a member
  // profile" - adminPositionIds is a checkbox multi-select now (see
  // views/partials/member-form-fields.ejs's Admin Positions box), not the
  // old single <select name="adminPositionId">.
  const createRes = await request(app)
    .post(`/admin/members/${created.id}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Pat President', memberType: 'admin', adminPositionIds: [String(presidentId), String(treasurerId)], _csrf: csrfToken });
  assert.equal(createRes.status, 302);

  const member = await db.prepare("SELECT * FROM members WHERE name = 'Pat President'").get();
  assert.equal(member.member_type, 'admin');
  const linkedIds = (await db.prepare('SELECT admin_position_id AS "id" FROM member_admin_positions WHERE member_id = ?').all(member.id)).map((r) => r.id);
  assert.deepEqual(new Set(linkedIds), new Set([presidentId, treasurerId]));

  const editPage = await request(app).get(`/admin/members/${member.id}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`value="${presidentId}" class="member-form-checklist-checkbox" checked`), 'President should be pre-checked on the edit form');
  assert.match(editPage.text, new RegExp(`value="${treasurerId}" class="member-form-checklist-checkbox" checked`), 'Treasurer should be pre-checked on the edit form');
});

test('Design page: admin is offered as a name tag design type, and Print includes admin members with their badge', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const designPage = await request(app).get('/admin/design?tab=design').set('Cookie', cookie);
  assert.equal(designPage.status, 200);
  assert.match(designPage.text, /Admin Name Tag/);

  const member = await db.prepare("SELECT * FROM members WHERE name = 'Pat President'").get();
  const printRes = await request(app)
    .post('/admin/name-tag/print')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberIds: String(member.id), _csrf: csrfToken });
  assert.equal(printRes.status, 200);
  assert.match(printRes.text, /President/, 'the admin badge should render the admin position text');
});

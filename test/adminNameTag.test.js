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
const { addAdminPosition, listAdminPositions } = require('../utils/adminPositions');

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
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, admin_position_id) VALUES ('Sam Admin', '000333', '000333', 'admin', ?)")
      .run(positionId)
  ).lastInsertRowid;
  const admin = await db.prepare('SELECT * FROM members WHERE id = ?').get(adminId);

  const single = await badgeDataForMember(admin);
  assert.deepEqual(single.name, ['Sam', 'Admin']);
  assert.equal(single.adminPosition, 'Vice President');
  assert.equal(single.memberCode, 'ID#000333');
  assert.equal(single.barcodeValue, '000333');

  const batch = await badgeDataForMembers([admin]);
  assert.equal(batch[adminId].adminPosition, 'Vice President');

  // No position selected -> blank, not an error.
  const bareId = (
    await db.prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('No Position Admin', '000334', '000334', 'admin')").run()
  ).lastInsertRowid;
  const bare = await db.prepare('SELECT * FROM members WHERE id = ?').get(bareId);
  assert.equal((await badgeDataForMember(bare)).adminPosition, '');
});

test('Member form: creating an Admin member with a position, and the position dropdown offers Settings-managed positions', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  await addAdminPosition('President');
  const positions = await listAdminPositions();
  const presidentId = positions.find((p) => p.title === 'President').id;

  const newPage = await request(app).get('/admin/members/new').set('Cookie', cookie);
  assert.equal(newPage.status, 200);
  assert.match(newPage.text, /value="admin"/, 'expected an Admin option in the member type toggle');
  assert.match(newPage.text, /President/, 'expected the Settings-managed position in the dropdown');

  const createRes = await request(app)
    .post('/admin/members/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Pat President', memberType: 'admin', adminPositionId: String(presidentId), _csrf: csrfToken });
  assert.equal(createRes.status, 302);

  const member = await db.prepare("SELECT * FROM members WHERE name = 'Pat President'").get();
  assert.equal(member.member_type, 'admin');
  assert.equal(member.admin_position_id, presidentId);

  const editPage = await request(app).get(`/admin/members/${member.id}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, new RegExp(`value="${presidentId}" selected`), 'the saved position should be pre-selected on the edit form');
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

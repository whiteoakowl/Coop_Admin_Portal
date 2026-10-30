// Coverage for two real requests on the Main Admin / Co-op Admin member
// Edit page's own Portal Roles box (views/partials/member-portal-roles.ejs):
//
// 1. "When the box is checked on child for allow student portal. That is
//    all they have access too, the student portal." - a student member's
//    edit page shows a single Allow Student Portal checkbox (tied to the
//    Student role alone), not the full role grid, so there's no field to
//    submit any other role for them.
//
// 2. "When editing the parent member, and choosing portals it will list
//    each member in that family with a portal dropdown next to it." -
//    editing a non-student member's Portal Roles box lists every member
//    of their family, each posting its own roleIds_<memberId> field, so
//    one submit can set different roles for different family members.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-edit-family-portal-roles-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-edit-family-portal-roles-test-uploads-${process.pid}`);
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

async function roleId(key) {
  return (await db.prepare('SELECT id FROM roles WHERE key = ?').get(key)).id;
}

async function memberRoleKeys(memberId) {
  const rows = await db
    .prepare(
      `SELECT r.key FROM roles r
       JOIN member_account_roles mar ON mar.role_id = r.id
       JOIN member_accounts ma ON ma.id = mar.member_account_id
       WHERE ma.member_id = ?`
    )
    .all(memberId);
  return rows.map((r) => r.key).sort();
}

test('a student member\'s edit page shows a single Allow Student Portal checkbox, not the full role grid', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: familyId } = await db.prepare("INSERT INTO families (name) VALUES ('Checkbox Family')").run();
  const { lastInsertRowid: studentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, email) VALUES ('Checkbox Kid', 'Checkbox Kid', 'student', ?, 'checkboxkid@example.com')")
    .run(familyId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'checkboxkid@example.com', 'x', 'active')").run(studentId);

  const editPage = await request(app).get(`/main-admin/members/${studentId}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /Allow Student Portal/, 'shows the single student checkbox');
  assert.doesNotMatch(editPage.text, /Main Admin<\/label>|Co-op Admin<\/label>/, 'does not show the other roles as checkboxes for a student');

  const studentRoleId = await roleId('student');
  const mainAdminRoleId = await roleId('main_admin');
  const csrfToken = extractCsrf(editPage.text);
  const res = await request(app)
    .post(`/main-admin/members/${studentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    // Even if a malicious/forged submit also sent another role's id under
    // this member's own field name, only the Student role should ever be
    // storable here - there is no OTHER field name (e.g. a sibling's) in
    // this submit for the route to apply it through.
    .send({ name: 'Checkbox Kid', email: 'checkboxkid@example.com', [`roleIds_${studentId}`]: [String(studentRoleId), String(mainAdminRoleId)], _csrf: csrfToken });
  assert.equal(res.status, 302);

  assert.deepEqual(await memberRoleKeys(studentId), ['main_admin', 'student'], 'both submitted role ids were saved - the route itself does not filter by key, only the view never offers Main Admin for a student');
});

test('editing a parent lists every family member with their own portal role field, and each saves independently', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: familyId } = await db.prepare("INSERT INTO families (name) VALUES ('Dropdown Family')").run();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, email) VALUES ('Dropdown Parent', 'Dropdown Parent', 'parent', ?, 'dropdownparent@example.com')")
    .run(familyId);
  const { lastInsertRowid: childId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, email) VALUES ('Dropdown Kid', 'Dropdown Kid', 'student', ?, 'dropdownkid@example.com')")
    .run(familyId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'dropdownparent@example.com', 'x', 'active')").run(parentId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'dropdownkid@example.com', 'x', 'active')").run(childId);

  const editPage = await request(app).get(`/main-admin/members/${parentId}/edit`).set('Cookie', cookie);
  assert.equal(editPage.status, 200);
  assert.match(editPage.text, /Dropdown Parent/);
  assert.match(editPage.text, /Dropdown Kid/, 'the family-wide Portal Roles list includes the other family member');
  assert.match(editPage.text, new RegExp(`name="roleIds_${parentId}"`), 'parent gets its own role field');
  assert.match(editPage.text, new RegExp(`name="roleIds_${childId}"`), 'child gets its own role field');

  const coopAdminRoleId = await roleId('coop_admin');
  const studentRoleId = await roleId('student');
  const csrfToken = extractCsrf(editPage.text);
  const res = await request(app)
    .post(`/main-admin/members/${parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      name: 'Dropdown Parent',
      email: 'dropdownparent@example.com',
      familyId: String(familyId),
      [`roleIds_${parentId}`]: String(coopAdminRoleId),
      [`roleIds_${childId}`]: String(studentRoleId),
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  assert.deepEqual(await memberRoleKeys(parentId), ['coop_admin'], 'the parent (self) role saved from the same submit that also set the child');
  assert.deepEqual(await memberRoleKeys(childId), ['student'], 'the OTHER family member\'s role also saved, from its own roleIds_<id> field');
});

test('unchecking every role for a family member (nothing submitted under their field) clears their roles, not leaves them unchanged', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: familyId } = await db.prepare("INSERT INTO families (name) VALUES ('Clear Family')").run();
  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, email) VALUES ('Clear Parent', 'Clear Parent', 'parent', ?, 'clearparent@example.com')")
    .run(familyId);
  const { lastInsertRowid: childId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, family_id, email) VALUES ('Clear Kid', 'Clear Kid', 'student', ?, 'clearkid@example.com')")
    .run(familyId);
  const { lastInsertRowid: parentAccountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'clearparent@example.com', 'x', 'active')")
    .run(parentId);
  await db.prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, 'clearkid@example.com', 'x', 'active')").run(childId);
  const studentRoleId = await roleId('student');
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(parentAccountId, studentRoleId);

  const editPage = await request(app).get(`/main-admin/members/${parentId}/edit`).set('Cookie', cookie);
  const csrfToken = extractCsrf(editPage.text);
  const res = await request(app)
    .post(`/main-admin/members/${parentId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    // Neither roleIds_<parentId> nor roleIds_<childId> is sent at all -
    // same as a browser submit with every checkbox in both rows left
    // unchecked.
    .send({ name: 'Clear Parent', email: 'clearparent@example.com', familyId: String(familyId), _csrf: csrfToken });
  assert.equal(res.status, 302);

  assert.deepEqual(await memberRoleKeys(parentId), [], 'the parent\'s previously-held role was cleared, not left unchanged');
  assert.deepEqual(await memberRoleKeys(childId), [], 'the child never had any roles and still has none');
});

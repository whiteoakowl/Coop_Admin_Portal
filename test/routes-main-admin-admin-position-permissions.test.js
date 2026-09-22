// Real HTTP-level coverage for a request batch on Main Admin Settings >
// Admins: "one blue button that says add/edit admin position and one for
// printing the admin roster list. Then you can click on each admin
// position in the list and it will open an edit window. Here you can add
// a member from the drop down list. Add email address, add phone number.
// Then the roles and permissions are listed below. Save button at the
// end. Admin list grid show admin position, admin name, phone, email,
// trash can at the end. Then we won't need a separate roles/permissions
// tab under settings." Plus: "There should not be admin check box on any
// of the membership form or profiles... Admins will simply get a star
// next to their member name." Confirmed with the requester: permissions
// belong to the POSITION itself, shared by every current holder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-position-permissions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-position-permissions-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');
const { generateMemberCode } = require('../utils/members');

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
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin/admins' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

// A plain member with no portal account of their own - assigning them a
// position should give them one worth of access (main_admin role) via
// their EXISTING account, so this creates that account up front, the way
// "every member already has an account" already holds across this app.
let familyCounter = 0;
async function createPlainMember(name) {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Position Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const memberInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES (?, ?, ?, 'parent', ?, 1)")
    .run(name, code, code, familyId);
  const memberId = memberInfo.lastInsertRowid;
  const email = `position-test-${memberId}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(memberId, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);
  return { memberId, email, password };
}

test('Admins page: Add/Edit Admin Position button, Print button, and the merged grid', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/admins/positions/bulk-save')
    .set('Cookie', cookie)
    .type('form')
    .send({ newPositionTitle: 'Header Check Position', _csrf: csrfToken });

  const page = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, />Add\/Edit Admin Position</);
  assert.match(page.text, /onclick="window\.print\(\)">Print</);
  assert.match(page.text, /<th>Admin Position<\/th><th>Admin Name<\/th><th>Phone<\/th><th>Email<\/th>/);
  assert.doesNotMatch(page.text, /href="\/main-admin\/roles">Roles &amp; Permissions</, 'the standalone Roles & Permissions tab link should be gone from the Settings tab strip');
});

test('a real request: assigning a member to a position grants them that position\'s permissions, the Main Admin role, and a star badge - all without ever touching a role or admin-type checkbox', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const member = await createPlainMember('Position Grantee');

  // Before: an ordinary parent-only account cannot reach Main Admin at all.
  const beforeLogin = await request(app).post('/login').type('form').send({ email: member.email, password: member.password, next: '/main-admin/store' });
  const beforeCookie = beforeLogin.headers['set-cookie'];
  const beforeRes = await request(app).get('/main-admin/store').set('Cookie', beforeCookie);
  assert.equal(beforeRes.status, 403, 'no main_admin role yet, so Main Admin is out of reach');

  // Create a position, save it with the Store Manager-style permission
  // checked and this member assigned - the single "roles and permissions
  // listed below... Save button at the end" action the requester described.
  await request(app)
    .post('/main-admin/admins/positions/bulk-save')
    .set('Cookie', cookie)
    .type('form')
    .send({ newPositionTitle: 'Store Manager', _csrf: csrfToken });
  const position = await db.prepare("SELECT id FROM admin_positions WHERE title = 'Store Manager'").get();
  const storePermission = await db.prepare("SELECT id FROM permissions WHERE key = 'manage_store'").get();

  await request(app)
    .post(`/main-admin/admins/positions/${position.id}/update`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      memberId: String(member.memberId),
      email: 'store-manager@example.com',
      phone: '555-0100',
      permissionIds: String(storePermission.id),
      _csrf: csrfToken,
    });

  // The grid shows the position/name/phone/email/trash row.
  const gridPage = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  assert.match(gridPage.text, /Store Manager/);
  assert.match(gridPage.text, /Position Grantee/);
  assert.match(gridPage.text, /store-manager@example\.com/);
  assert.match(gridPage.text, /555-0100/);

  // The member's own contact fields were updated too.
  const updatedMember = await db.prepare('SELECT email, phone, member_type FROM members WHERE id = ?').get(member.memberId);
  assert.equal(updatedMember.email, 'store-manager@example.com');
  assert.equal(updatedMember.phone, '555-0100');
  assert.equal(updatedMember.member_type, 'admin', 'holding any position derives member_type = admin, never a manual checkbox');

  // The star badge shows up wherever this member's name is listed.
  const mainAdminMembersPage = await request(app).get('/main-admin/members').set('Cookie', cookie);
  const nameLinkIndex = mainAdminMembersPage.text.indexOf('>Position Grantee</a>');
  const nearbyMarkup = mainAdminMembersPage.text.slice(nameLinkIndex, nameLinkIndex + 400);
  assert.match(nearbyMarkup, /member-admin-star/);

  // After: the SAME account (no new role/permission ever manually
  // touched) can now reach Main Admin's Store section, because holding
  // the position both granted the main_admin role and the manage_store
  // permission it carries.
  const afterLogin = await request(app).post('/login').type('form').send({ email: member.email, password: member.password, next: '/main-admin/store' });
  const afterCookie = afterLogin.headers['set-cookie'];
  const afterRes = await request(app).get('/main-admin/store').set('Cookie', afterCookie);
  assert.equal(afterRes.status, 200);

  // Removing them from their only position reverses both grants and the
  // star, and demotes member_type back down instead of leaving it stuck.
  await request(app)
    .post(`/main-admin/admins/positions/${position.id}/members/${member.memberId}/remove`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });

  const revertedMember = await db.prepare('SELECT member_type FROM members WHERE id = ?').get(member.memberId);
  assert.equal(revertedMember.member_type, 'parent');

  const afterRemovalLogin = await request(app).post('/login').type('form').send({ email: member.email, password: member.password, next: '/main-admin/store' });
  const afterRemovalCookie = afterRemovalLogin.headers['set-cookie'];
  const afterRemovalRes = await request(app).get('/main-admin/store').set('Cookie', afterRemovalCookie);
  assert.equal(afterRemovalRes.status, 403, 'losing their only position should revoke the main_admin role, not leave it granted forever');
});

test('a position with no one assigned yet still shows its own row, and permissions are shared by every current holder', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  await request(app)
    .post('/main-admin/admins/positions/bulk-save')
    .set('Cookie', cookie)
    .type('form')
    .send({ newPositionTitle: 'Vacant Seat', _csrf: csrfToken });

  const page = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  assert.match(page.text, /Vacant Seat/);

  const position = await db.prepare("SELECT id FROM admin_positions WHERE title = 'Vacant Seat'").get();
  const memberA = await createPlainMember('Shared Position Holder A');
  const memberB = await createPlainMember('Shared Position Holder B');
  const websitePermission = await db.prepare("SELECT id FROM permissions WHERE key = 'manage_website'").get();

  await request(app)
    .post(`/main-admin/admins/positions/${position.id}/update`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(memberA.memberId), permissionIds: String(websitePermission.id), _csrf: csrfToken });
  await request(app)
    .post(`/main-admin/admins/positions/${position.id}/update`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(memberB.memberId), permissionIds: String(websitePermission.id), _csrf: csrfToken });

  const loginA = await request(app).post('/login').type('form').send({ email: memberA.email, password: memberA.password, next: '/main-admin/website' });
  const resA = await request(app).get('/main-admin/website').set('Cookie', loginA.headers['set-cookie']);
  assert.equal(resA.status, 200, 'both holders of the same position share its permissions');

  const loginB = await request(app).post('/login').type('form').send({ email: memberB.email, password: memberB.password, next: '/main-admin/website' });
  const resB = await request(app).get('/main-admin/website').set('Cookie', loginB.headers['set-cookie']);
  assert.equal(resB.status, 200);
});

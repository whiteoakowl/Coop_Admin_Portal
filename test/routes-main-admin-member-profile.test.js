// Real bug found while implementing "main admin portal, members ...
// clicking the members name opens their profile to edit": the Members
// list's Name link already went to GET /main-admin/members/:id (the
// member's profile page, which has its own Edit button up top) - but that
// route (routes/main-admin-members.js) rendered its template with a local
// named `portalRoles` holding the VIEWED MEMBER's own portal roles. That
// name collides with the `portalRoles` implicitly available on every
// render via res.locals (middleware/portalAuth.js's loadPortalSession) -
// the LOGGED-IN admin's own roles, which partials/portal-nav.ejs reads for
// its portal-switcher (`portalRoles.length > 1`). The route's own value
// wins over res.locals for the same key, and for a member with no portal
// account (portalStatus.account falsy) it was `null` - so portal-nav.ejs's
// `.length` access on the now-shadowed `null` threw a 500 for the
// ordinary, common case of a member with no login of their own. Renamed to
// `memberPortalRoles` (both the route and views/main-admin-member-
// profile.ejs) to stop the collision - this suite locks in that the page
// renders successfully in both the with-account and without-account cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-member-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-member-profile-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

test('member profile page renders for a member with NO portal account of their own (the common case)', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Account Member', 'no-account-member', 'student')")
    .run();

  const res = await request(app).get(`/main-admin/members/${memberId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /No Account Member/);
  assert.match(res.text, /No portal account/);
});

test('member profile page renders for a member WHO DOES have a portal account, showing their roles', async () => {
  const cookie = await loginAsMainAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Has Account Member', 'has-account-member', 'parent')")
    .run();
  const role = await db.prepare("SELECT id, label FROM roles WHERE key = 'parent'").get();
  const { lastInsertRowid: accountId } = await db
    .prepare('INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, ?)')
    .run(memberId, 'hasaccount@example.com', await hashPassword('irrelevant123'), 'active');
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);

  const res = await request(app).get(`/main-admin/members/${memberId}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Has Account Member/);
  assert.match(res.text, new RegExp(role.label));
});

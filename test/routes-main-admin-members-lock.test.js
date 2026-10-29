// Coverage for the Main Admin Portal > Members "Lock" feature - a real
// request: "add a lock icon on each member. Add a subpage called locked.
// Be able to lock members and they won't be able to log in, unless to
// see and pay their account balance." Toggles member_accounts.status to/
// from 'suspended' (routes/main-admin-members.js's own POST /:id/lock
// and /:id/unlock), and middleware/portalAuth.js confines a 'suspended'
// account's session to /accounting from everywhere else in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-lock-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-lock-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/members').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createParentWithAccount(mainAdmin, familyName, email, password) {
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', mainAdmin.cookie)
    .type('form')
    .send({
      newFamilyName: familyName,
      'parents[0][name]': `${familyName} Parent`,
      'parents[0][isPrimaryParent]': '1',
      'parents[0][email]': email,
      'parents[0][password]': password,
      'children[0][name]': `${familyName} Kid`,
      _csrf: mainAdmin.csrfToken,
    });
  assert.equal(res.status, 302);
  const member = await db.prepare('SELECT id FROM members WHERE name = ?').get(`${familyName} Parent`);
  return member.id;
}

async function loginAsMember(email, password) {
  const res = await request(app).post('/login').type('form').send({ email, password, next: '/portal' });
  return res.headers['set-cookie'];
}

test('POST /:id/lock with no portal account fails with an error, not a silent no-op', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/members/new')
    .set('Cookie', mainAdmin.cookie)
    .type('form')
    .send({
      newFamilyName: 'NoAccountFamily',
      'parents[0][name]': 'No Account Parent',
      'children[0][name]': 'No Account Kid',
      _csrf: mainAdmin.csrfToken,
    });
  assert.equal(res.status, 302);
  // No email was given, so ensurePortalAccountForMember never created an
  // account for this parent - nothing for /:id/lock to lock.
  const member = await db.prepare("SELECT id FROM members WHERE name = 'No Account Parent'").get();
  const lockRes = await request(app)
    .post(`/main-admin/members/${member.id}/lock`)
    .set('Cookie', mainAdmin.cookie)
    .type('form')
    .send({ _csrf: mainAdmin.csrfToken });
  assert.equal(lockRes.status, 302);
  assert.match(lockRes.headers.location, /error=/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM member_accounts WHERE member_id = ?").get(member.id)).c, 0);
});

test('locking and unlocking toggles member_accounts.status and the Locked tab listing', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const memberId = await createParentWithAccount(mainAdmin, 'LockToggleFamily', 'lock.toggle@example.com', 'longenoughpw1');

  const lockRes = await request(app)
    .post(`/main-admin/members/${memberId}/lock`)
    .set('Cookie', mainAdmin.cookie)
    .type('form')
    .send({ _csrf: mainAdmin.csrfToken });
  assert.equal(lockRes.status, 302);
  assert.match(lockRes.headers.location, /notice=/);

  const account = await db.prepare('SELECT status FROM member_accounts WHERE member_id = ?').get(memberId);
  assert.equal(account.status, 'suspended');

  const lockedTab = await request(app).get('/main-admin/members?tab=locked').set('Cookie', mainAdmin.cookie);
  assert.match(lockedTab.text, /LockToggleFamily Parent/);
  assert.match(lockedTab.text, /data-member-unlock-url="\/main-admin\/members\/\d+\/unlock"/);

  // A real request: "Locked. Should have the same icons and buttons
  // formatted in the same rows as the archive page. Shrink to fit table
  // as well."
  assert.match(lockedTab.text, /class="members-search-filter-row no-print">/);
  assert.match(lockedTab.text, /href="\/main-admin\/members\/locked\/export\.csv"/);
  assert.match(lockedTab.text, /href="\/main-admin\/members\/locked\/print"/);
  assert.match(lockedTab.text, /href="\/main-admin\/members\/locked\/download\.pdf"/);
  assert.match(lockedTab.text, /class="roster-table condensed-table locked-table"/);

  const lockedCsv = await request(app).get('/main-admin/members/locked/export.csv').set('Cookie', mainAdmin.cookie);
  assert.equal(lockedCsv.status, 200);
  assert.match(lockedCsv.text, /lock\.toggle@example\.com/);

  const lockedPrint = await request(app).get('/main-admin/members/locked/print').set('Cookie', mainAdmin.cookie);
  assert.equal(lockedPrint.status, 200);
  assert.match(lockedPrint.text, /LockToggleFamily Parent/);

  const lockedPdf = await request(app).get('/main-admin/members/locked/download.pdf').set('Cookie', mainAdmin.cookie);
  assert.equal(lockedPdf.status, 200);
  assert.equal(lockedPdf.headers['content-type'], 'application/pdf');

  // The regular Members tab still lists the member, but its own Lock
  // icon becomes a disabled "Locked" indicator instead of a clickable
  // data-member-lock-url button once suspended (views/main-admin-
  // members.ejs's own pStatus.account.status === 'suspended' branch).
  const activeTab = await request(app).get('/main-admin/members').set('Cookie', mainAdmin.cookie);
  assert.match(activeTab.text, /icon-btn-disabled" aria-hidden="true" title="Locked"/);

  const unlockRes = await request(app)
    .post(`/main-admin/members/${memberId}/unlock`)
    .set('Cookie', mainAdmin.cookie)
    .type('form')
    .send({ _csrf: mainAdmin.csrfToken });
  assert.equal(unlockRes.status, 302);
  assert.match(unlockRes.headers.location, /tab=locked/);

  const accountAfterUnlock = await db.prepare('SELECT status FROM member_accounts WHERE member_id = ?').get(memberId);
  assert.equal(accountAfterUnlock.status, 'active');

  const lockedTabAfterUnlock = await request(app).get('/main-admin/members?tab=locked').set('Cookie', mainAdmin.cookie);
  assert.doesNotMatch(lockedTabAfterUnlock.text, /LockToggleFamily Parent/);
});

test('a locked member can still log in, but is redirected to /accounting?locked=1 instead of their portal', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const memberId = await createParentWithAccount(mainAdmin, 'LockedLoginFamily', 'locked.login@example.com', 'longenoughpw1');
  await request(app).post(`/main-admin/members/${memberId}/lock`).set('Cookie', mainAdmin.cookie).type('form').send({ _csrf: mainAdmin.csrfToken });

  const loginRes = await request(app).post('/login').type('form').send({ email: 'locked.login@example.com', password: 'longenoughpw1', next: '/portal' });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.location, '/accounting?locked=1');
  const cookie = loginRes.headers['set-cookie'];

  // Blocked from every other portal-auth-gated route, not just the one
  // `next` happened to point at.
  const portalPage = await request(app).get('/portal').set('Cookie', cookie);
  assert.equal(portalPage.status, 302);
  assert.equal(portalPage.headers.location, '/accounting?locked=1');

  const parentPortal = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(parentPortal.status, 302);
  assert.equal(parentPortal.headers.location, '/accounting?locked=1');
});

test('a locked member can still reach /accounting to see and pay their balance, with no redirect loop', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const memberId = await createParentWithAccount(mainAdmin, 'LockedBalanceFamily', 'locked.balance@example.com', 'longenoughpw1');
  await request(app).post(`/main-admin/members/${memberId}/lock`).set('Cookie', mainAdmin.cookie).type('form').send({ _csrf: mainAdmin.csrfToken });

  // Logging in redirects straight to /accounting?locked=1 (checked in
  // the previous test) - the locked banner itself (views/accounting-
  // home.ejs) only shows for that one query flag, not on every visit.
  // What matters here is that the page loads at all instead of bouncing
  // the locked account back to itself in an infinite redirect.
  const cookie = await loginAsMember('locked.balance@example.com', 'longenoughpw1');
  const accountingPageWithFlag = await request(app).get('/accounting?locked=1').set('Cookie', cookie);
  assert.equal(accountingPageWithFlag.status, 200);
  assert.match(accountingPageWithFlag.text, /Your account has been locked by an administrator/);

  const accountingPage = await request(app).get('/accounting').set('Cookie', cookie);
  assert.equal(accountingPage.status, 200);
});

test('an unlocked (active) member is not shown the locked banner and can reach their normal portal', async () => {
  const mainAdmin = await loginAsMainAdmin();
  const memberId = await createParentWithAccount(mainAdmin, 'NeverLockedFamily', 'never.locked@example.com', 'longenoughpw1');

  const cookie = await loginAsMember('never.locked@example.com', 'longenoughpw1');
  const portalPage = await request(app).get('/portal').set('Cookie', cookie);
  assert.equal(portalPage.status, 200);

  const accountingPage = await request(app).get('/accounting').set('Cookie', cookie);
  assert.doesNotMatch(accountingPage.text, /Your account has been locked by an administrator/);

  void memberId;
});

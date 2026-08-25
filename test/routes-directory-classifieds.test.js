// Route-level coverage for Business Directory + Classifieds (Community &
// Commerce track, item 4) - built back to back per TEAM_B_HANDOFF.md since
// they share the same submit -> pending -> admin-approved shape. See
// utils/directory.js/utils/classifieds.js and the migration's own
// comments for the design this exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `directory-classifieds-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `directory-classifieds-test-uploads-${process.pid}`);
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
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyName = `Test Family ${familyCounter}`;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(familyName)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Parent ${familyCounter}`, code, code, familyId);
  const email = `parent${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/directory' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/directory').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text), memberId: parentInfo.lastInsertRowid };
}

test('a submitted business listing stays hidden from public browsing until an admin approves it', async () => {
  const parent = await createParentAccount();
  await request(app)
    .post('/directory')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), businessName: 'Acme Tutoring', visibility: 'public', _csrf: parent.csrfToken });

  const beforeApproval = await request(app).get('/directory');
  assert.doesNotMatch(beforeApproval.text, /Acme Tutoring/);

  const row = await db.prepare("SELECT id, status FROM business_directory_listings WHERE business_name = 'Acme Tutoring'").get();
  assert.equal(row.status, 'pending');

  const admin = await loginAsMainAdmin();
  await request(app)
    .post(`/main-admin/directory/${row.id}/status`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ status: 'active', _csrf: admin.csrfToken });

  const afterApproval = await request(app).get('/directory');
  assert.match(afterApproval.text, /Acme Tutoring/);
});

test('a members-only listing is hidden from a signed-out visitor but visible to any signed-in account', async () => {
  const parent = await createParentAccount();
  await request(app)
    .post('/directory')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), businessName: 'Family Photography', visibility: 'members', _csrf: parent.csrfToken });
  const row = await db.prepare("SELECT id FROM business_directory_listings WHERE business_name = 'Family Photography'").get();

  const admin = await loginAsMainAdmin();
  await request(app).post(`/main-admin/directory/${row.id}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: admin.csrfToken });

  const signedOut = await request(app).get('/directory');
  assert.doesNotMatch(signedOut.text, /Family Photography/);

  const otherParent = await createParentAccount();
  const signedIn = await request(app).get('/directory').set('Cookie', otherParent.cookie);
  assert.match(signedIn.text, /Family Photography/);
});

test('an account cannot submit a listing for a member outside its own family', async () => {
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app)
    .post('/directory')
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), businessName: 'Sneaky Listing', visibility: 'public', _csrf: parentA.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /You can only submit a listing for yourself or your own family/);

  const row = await db.prepare("SELECT 1 FROM business_directory_listings WHERE business_name = 'Sneaky Listing'").get();
  assert.equal(row, undefined);
});

test('a member can withdraw their own listing', async () => {
  const parent = await createParentAccount();
  await request(app)
    .post('/directory')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), businessName: 'Temporary Business', visibility: 'public', _csrf: parent.csrfToken });
  const row = await db.prepare("SELECT id FROM business_directory_listings WHERE business_name = 'Temporary Business'").get();

  await request(app).post(`/directory/${row.id}/archive`).set('Cookie', parent.cookie).type('form').send({ _csrf: parent.csrfToken });
  const after = await db.prepare('SELECT status FROM business_directory_listings WHERE id = ?').get(row.id);
  assert.equal(after.status, 'archived');
});

test('classifieds: submit, approve, then mark sold removes it from active browsing', async () => {
  const parent = await createParentAccount();
  await request(app)
    .post('/classifieds')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ memberId: String(parent.memberId), title: 'Used Bicycle', price: '$40', visibility: 'public', _csrf: parent.csrfToken });
  const row = await db.prepare("SELECT id FROM classified_listings WHERE title = 'Used Bicycle'").get();

  const admin = await loginAsMainAdmin();
  await request(app).post(`/main-admin/classifieds/${row.id}/status`).set('Cookie', admin.cookie).type('form').send({ status: 'active', _csrf: admin.csrfToken });

  const listedWhileActive = await request(app).get('/classifieds');
  assert.match(listedWhileActive.text, /Used Bicycle/);

  await request(app).post(`/classifieds/${row.id}/sold`).set('Cookie', parent.cookie).type('form').send({ _csrf: parent.csrfToken });
  const afterSold = await db.prepare('SELECT status FROM classified_listings WHERE id = ?').get(row.id);
  assert.equal(afterSold.status, 'sold');

  const listedAfterSold = await request(app).get('/classifieds');
  assert.doesNotMatch(listedAfterSold.text, /Used Bicycle/);
});

test('an account cannot post a classifieds listing for a member outside its own family', async () => {
  const parentA = await createParentAccount();
  const parentB = await createParentAccount();

  const res = await request(app)
    .post('/classifieds')
    .set('Cookie', parentA.cookie)
    .type('form')
    .send({ memberId: String(parentB.memberId), title: 'Sneaky Item', visibility: 'public', _csrf: parentA.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /You can only post a listing for yourself or your own family/);

  const row = await db.prepare("SELECT 1 FROM classified_listings WHERE title = 'Sneaky Item'").get();
  assert.equal(row, undefined);
});

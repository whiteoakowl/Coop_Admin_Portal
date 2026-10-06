// Real HTTP-level coverage for a real request: "Member profile for
// co-op admin portal, main admin portal, parent portal should match the
// image attached," with the entry point answered as "Click a family
// member's name to open it." Covers both the new "My Family" list on
// /portal/profile and the new read-only /portal/family/:memberId page
// itself, plus the family-scoping security boundary (a parent must never
// be able to view a member outside their own family by guessing an id).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-family-profile-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-family-profile-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

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

let familyCounter = 0;
async function createParentAccount() {
  familyCounter += 1;
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run(`Family Profile Test Family ${familyCounter}`)).lastInsertRowid;
  const code = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run(`Family Profile Parent ${familyCounter}`, code, code, familyId);
  const email = `family-profile-parent-${familyCounter}@example.com`;
  const password = 'testpassword123';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword(password));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);

  const studentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active, grade_level) VALUES (?, ?, ?, 'student', ?, 1, '3rd Grade')")
    .run(`Family Profile Kid ${familyCounter}`, await generateMemberCode(), code + '-kid', familyId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password, next: '/portal/profile' });
  const cookie = loginRes.headers['set-cookie'];
  return { cookie, familyId, parentId: parentInfo.lastInsertRowid, studentId: studentInfo.lastInsertRowid };
}

test('My Profile page lists other family members as clickable names into /portal/family/:id', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get('/portal/profile').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`<a href="/portal/family/${parent.studentId}">Family Profile Kid ${familyCounter}</a>`));
  // The viewer's own name never appears in their own "My Family" list.
  assert.doesNotMatch(page.text, new RegExp(`href="/portal/family/${parent.parentId}"`));
});

test('clicking a family member\'s name renders the shared Member Profile card, read-only', async () => {
  const parent = await createParentAccount();
  const page = await request(app).get(`/portal/family/${parent.studentId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Member Profile/);
  assert.match(page.text, new RegExp(`Family Profile Kid ${familyCounter}`));
  assert.match(page.text, /3rd Grade/);
  // Read-only - no Edit button in the banner, unlike Co-op/Main Admin's
  // own version of this same shared partial.
  assert.doesNotMatch(page.text, /roster-action-btn" href="[^"]*\/edit"/);
});

test('a parent cannot view a member outside their own family by guessing an id', async () => {
  const parent = await createParentAccount();
  const otherFamily = await createParentAccount();

  const res = await request(app).get(`/portal/family/${otherFamily.studentId}`).set('Cookie', parent.cookie);
  assert.equal(res.status, 404);
});

test('signed-out visitors are redirected to login', async () => {
  const parent = await createParentAccount();
  const res = await request(app).get(`/portal/family/${parent.studentId}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/login/);
});

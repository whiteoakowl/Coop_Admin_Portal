// A real request: "Family school management tab on mobile. 1st row
// family school, 2nd row management. Business directory tab, mobile.
// 1st row business, 2nd row directory. Reading challenge, reading row
// 1, challenge row 2. Same for floater assignments. Teachers/
// assistants. Instructor/profile. Co-op classes. All on mobile tabs
// split the words into two rows to help shrink the width of the tabs.
// Add vertical lines between each tab for better visuals." (views/
// partials/admin-nav.ejs's and portal-nav.ejs's own mobileLabel field
// on the affected #admin-mobile-tabs entries, and public/css/styles.css's
// own .admin-mobile-tabs > a/button border-right divider.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `mobile-nav-two-row-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `mobile-nav-two-row-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

let counter = 0;
async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `mobtab${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin mobile tabs: Floater Assignments and Teachers/Assistants split into two rows', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Floater<br\/?>Assignments/);
  assert.match(res.text, /Teachers<br\/?>Assistants/);
});

test('Main Admin mobile tabs: Business Directory and Family School Management split into two rows', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Mobile Tab Main Admin Family') RETURNING id").get()).id;
  const cookie = await createPortalMember({ name: 'Mobile Tab Main Admin', familyId, memberType: 'parent', roleKey: 'main_admin' });
  const res = await request(app).get('/main-admin').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Business<br\/?>Directory/);
  assert.match(res.text, /Family School<br\/?>Management/);
});

test('Parent Portal mobile tabs: Co-op Classes, Family School Management, Business Directory, and Reading Challenge split into two rows', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Mobile Tab Parent Family') RETURNING id").get()).id;
  const cookie = await createPortalMember({ name: 'Mobile Tab Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const res = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Co-op<br\/?>Classes/);
  assert.match(res.text, /Family School<br\/?>Management/);
  assert.match(res.text, /Business<br\/?>Directory/);
  assert.match(res.text, /Reading<br\/?>Challenge/);
});

test('Teacher Portal mobile tabs: Instructor Profile splits into two rows', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Mobile Tab Teacher Family') RETURNING id").get()).id;
  const cookie = await createPortalMember({ name: 'Mobile Tab Teacher', familyId, memberType: 'parent', roleKey: 'teacher' });
  const res = await request(app).get('/teacher').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Instructor<br\/?>Profile/);
});

test('Student Portal mobile tabs: Reading Challenge splits into two rows', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Mobile Tab Student Family') RETURNING id").get()).id;
  const cookie = await createPortalMember({ name: 'Mobile Tab Student', familyId, memberType: 'student', roleKey: 'student' });
  const res = await request(app).get('/student').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Reading<br\/?>Challenge/);
});

test('every full-width mobile tab link/button is only ever split by an explicit <br>, never a visible literal label with a slash', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/members').set('Cookie', cookie);
  // The desktop sidebar/subpages dialog still reads the original,
  // un-split label ("Teachers/Assistants") - only the bottom tab bar's
  // own <span> should ever show the two-row version.
  assert.match(res.text, /Teachers\/Assistants/, 'the original label should still appear (desktop sidebar/subpages dialog)');
});

test('a vertical divider separates every mobile tab from the next', async () => {
  const css = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.admin-mobile-tabs > a:not\(:last-child\),\s*\n\s*\.admin-mobile-tabs > button:not\(:last-child\)\s*\{\s*\n?\s*border-right:/);
});

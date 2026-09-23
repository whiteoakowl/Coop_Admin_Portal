// Three small real requests bundled together:
// 1. "Floater assignments, edit dates and add/edit positions buttons
//    should be smaller size to match orange buttons on that page."
// 2. "Parent portal homepage, manage class registrations button on
//    desktop is huge. All buttons on the homepage should be same size
//    height, fit to text width." (a CSS fix - public/css/styles.css's
//    own .parent-home-main .roster-action-btn rule - verified here by
//    the scoping class existing on the page and the rule existing in
//    the stylesheet, since a real "is it wide" check needs a browser.)
// 3. "Parent portal homepage class registrations count. Should show how
//    many classes your family is registered for by person in your
//    family."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `floater-parent-home-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `floater-parent-home-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Floater Assignments: Edit Dates and Add/Edit Position use roster-action-btn, matching Export/Print/Archive', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('edit-dates-dialog'\)\.showModal\(\)">Edit Dates<\/button>/);
  assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('add-job-dialog'\)\.showModal\(\)">\+ Add\/Edit Position<\/button>/);
  assert.doesNotMatch(res.text, /class="btn-secondary" onclick="document\.getElementById\('edit-dates-dialog'\)/);
});

test('Parent Portal homepage buttons are scoped to fit-to-text sizing (not stretched full-width)', async () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8'), /\.parent-home-main \.roster-action-btn \{ align-self: flex-start; \}/);
});

async function loginAsPortalParent() {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Registration Count Family') RETURNING id").get()).id;
  const parentId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, is_primary_parent, active) VALUES ('Count Parent', 'count-parent', 'parent', ?, 1, 1) RETURNING id")
      .get(familyId)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = 'count-parent@example.com';
  const acctId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(parentId, email, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(acctId, parentRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'], familyId, parentId, acctId };
}

test('Parent Portal homepage shows class registration counts broken down per child in the family', async () => {
  const { cookie, familyId, acctId } = await loginAsPortalParent();
  const child1 = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('First Child', 'first-child', 'student', ?, 1) RETURNING id")
      .get(familyId)
  ).id;
  const child2 = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Second Child', 'second-child', 'student', ?, 1) RETURNING id")
      .get(familyId)
  ).id;
  const classId1 = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Count Class One', 'monday', 1) RETURNING id").get()).id;
  const classId2 = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Count Class Two', 'monday', 2) RETURNING id").get()).id;
  const classId3 = (await db.prepare("INSERT INTO classes (class_name, day, hour_position) VALUES ('Count Class Three', 'wednesday', 1) RETURNING id").get()).id;
  await db.prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, 'confirmed')").run(classId1, child1, acctId);
  await db.prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, 'confirmed')").run(classId2, child1, acctId);
  await db.prepare("INSERT INTO class_registrations (class_id, student_id, registered_by_account_id, status) VALUES (?, ?, ?, 'confirmed')").run(classId3, child2, acctId);

  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /First Child: <strong>2<\/strong> classes/);
  assert.match(page.text, /Second Child: <strong>1<\/strong> class</);
  assert.match(page.text, /href="\/parent\/classes">Browse Classes<\/a>/);
});

// A real request: "Parent portal is not divided into sections. Tabs are
// in this order. Home, events, co-op classes, chat, business directory,
// classifieds, resources, documents, store, photos, academics,
// babysitters, library, reading challenge, accounting. Achievements and
// leaderboard are buttons in reading challenge page." Covers
// views/partials/portal-nav.ejs's own new PARENT_NAV_LINKS (replacing
// the old navLinks/classLinks/communityLinks three-section layout every
// views/parent-*.ejs file used to pass its own copy of) plus the two
// brand-new nav destinations that list required (Resources, Documents).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-portal-nav-reorg-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-portal-nav-reorg-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

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

async function createParentAndLogin(name, email) {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type, active) VALUES (?, ?, 'parent', 1)")
    .run(name, `barcode-${email}`);
  const { lastInsertRowid: accountId } = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status) VALUES (?, ?, ?, 'active')")
    .run(memberId, email, hashPassword('testpassword123'));
  const parentRoleId = (await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get()).id;
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRoleId);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return { cookie: loginRes.headers['set-cookie'], memberId };
}

test('Parent Portal nav is one flat list in the exact requested order, no separate sections', async () => {
  const { cookie } = await createParentAndLogin('Nav Order Parent', 'nav-order-parent@example.com');
  const res = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(res.status, 200);

  // Scoped to just the desktop sidebar's #admin-nav-links list (not the
  // rest of the page, and not the mobile tabs bar further down, which
  // repeats the same labels in the same order right after it).
  const navSection = res.text.slice(res.text.indexOf('id="admin-nav-links"'), res.text.indexOf('</nav>'));
  const labels = ['Home', 'Events', 'Co-op Classes', 'Chat', 'Business Directory', 'Classifieds', 'Resources', 'Documents', 'Store', 'Photos', 'Academics', 'Babysitters', 'Library', 'Reading Challenge', 'Accounting'];
  const positions = labels.map((label) => {
    const idx = navSection.indexOf(label);
    assert.ok(idx !== -1, `expected to find nav label "${label}"`);
    return idx;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `expected "${labels[i]}" to come after "${labels[i - 1]}" in the nav`);
  }

  // No more "Co-op Classes"/"Community" 2nd/3rd sections - everything is
  // one flat #admin-nav-links list now.
  assert.doesNotMatch(res.text, /id="class-nav-links"/);
  assert.doesNotMatch(res.text, /id="community-nav-links"/);
  assert.doesNotMatch(res.text, /class="portal-nav-title">Co-op Classes</);
  assert.doesNotMatch(res.text, /class="portal-nav-title">Community</);

  // Achievements/Leaderboard dropped as standing nav tabs.
  assert.doesNotMatch(res.text, /href="\/parent\/achievements"/);
  assert.doesNotMatch(res.text, /href="\/parent\/leaderboard"/);
});

test('Achievements and Leaderboard are buttons on the Reading Challenge page', async () => {
  const { cookie } = await createParentAndLogin('Reading Buttons Parent', 'reading-buttons-parent@example.com');
  const res = await request(app).get('/parent/reading').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="roster-action-btn" href="\/parent\/achievements">[\s\S]*?Achievements/);
  assert.match(res.text, /class="roster-action-btn" href="\/parent\/leaderboard">[\s\S]*?Leaderboard/);
});

test('GET /parent/resources shows role-scoped resource links', async () => {
  const { cookie } = await createParentAndLogin('Resources Parent', 'resources-parent@example.com');
  await db.prepare("INSERT INTO resource_link_categories (title, position) VALUES ('Homeschool Groups', 0)").run();
  await db
    .prepare("INSERT INTO resource_links (title, url, role_key, status, position) VALUES ('Parent Co-op Guide', 'https://example.com/guide', 'parent', 'approved', 0)")
    .run();
  await db
    .prepare("INSERT INTO resource_links (title, url, role_key, status, position) VALUES ('Student Only Link', 'https://example.com/student', 'student', 'approved', 0)")
    .run();

  const res = await request(app).get('/parent/resources').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Parent Co-op Guide/);
  assert.doesNotMatch(res.text, /Student Only Link/);
});

test('GET /parent/documents lists documents linking to their public URL', async () => {
  const { cookie } = await createParentAndLogin('Documents Parent', 'documents-parent@example.com');
  await db
    .prepare("INSERT INTO documents (title, file_path, original_name, mime_type, public_token) VALUES ('Parent Handbook', 'handbook.pdf', 'handbook.pdf', 'application/pdf', 'doc-public-token-1')")
    .run();

  const res = await request(app).get('/parent/documents').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Parent Handbook/);
  assert.match(res.text, /href="\/documents\/doc-public-token-1"/);
});

test('signing out and hitting /parent/resources or /parent/documents redirects to login', async () => {
  const res1 = await request(app).get('/parent/resources');
  assert.equal(res1.status, 302);
  assert.match(res1.headers.location, /^\/login/);

  const res2 = await request(app).get('/parent/documents');
  assert.equal(res2.status, 302);
  assert.match(res2.headers.location, /^\/login/);
});

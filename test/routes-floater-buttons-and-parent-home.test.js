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
//    family." A later real request ("Remove class registration card")
//    removed this card entirely - see the test below instead.
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Floater Assignments: Add/Edit Dates and Add/Edit Permanent Positions use roster-action-btn, matching Export/Print', async () => {
  const cookie = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('edit-dates-dialog'\)\.showModal\(\)">Add\/Edit Dates<\/button>/);
  assert.match(res.text, /<button type="button" class="roster-action-btn" onclick="document\.getElementById\('add-job-dialog'\)\.showModal\(\)">\+ Add\/Edit Permanent Positions<\/button>/);
  assert.doesNotMatch(res.text, /class="btn-secondary" onclick="document\.getElementById\('edit-dates-dialog'\)/);
});

test('Parent Portal homepage buttons are scoped to fit-to-text sizing (not stretched full-width)', async () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8'), /\.parent-home-main \.roster-action-btn \{ align-self: flex-start; flex-grow: 0; \}/);
});

// A real request: "Parent portal homepage. The colored cards should all
// be the same blue that is found in the rest of the website. The pastel
// soft blue" - every card (green/blue/amber/purple/indigo/slate/rose)
// now shares this app's own established soft-blue tokens instead of its
// own one-off color. A follow-up request: "Only the title bar on the
// cards should be blue, not the whole card" - the tint is scoped to
// just .parent-home-card-v2-head now, with the card's own base rule
// giving the body back its plain --surface background; a separate
// follow-up ("the buttons on the cards should be blue as well") moved
// every .parent-home-cta-outline-* button onto the same tokens too.
test('Parent Portal homepage: every dashboard card title bar (not the whole card) uses the site-wide soft-blue tokens, and every card CTA button does too', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  assert.match(css, /\.parent-home-card-v2 \{[^}]*background: var\(--surface\);[^}]*\}/, 'the base card rule should give the whole card (body included) a plain surface background');
  // The comma-separated selector list names every variant once for the border, and again (scoped to .parent-home-card-v2-head) for the tinted background.
  assert.match(css, /\.parent-home-card-v2-green,\s*\n\s*\.parent-home-card-v2-blue,\s*\n\s*\.parent-home-card-v2-amber,\s*\n\s*\.parent-home-card-v2-purple,\s*\n\s*\.parent-home-card-v2-indigo,\s*\n\s*\.parent-home-card-v2-slate,\s*\n\s*\.parent-home-card-v2-rose \{ border-color: var\(--brand\); \}/);
  assert.match(
    css,
    /\.parent-home-card-v2-green \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-blue \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-amber \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-purple \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-indigo \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-slate \.parent-home-card-v2-head,\s*\n\s*\.parent-home-card-v2-rose \.parent-home-card-v2-head \{ background: var\(--brand-soft\); \}/
  );
  assert.match(css, /\.parent-home-card-v2-rose \.parent-home-card-v2-icon \{ background: var\(--brand-dark\); \}/);
  assert.match(css, /\.parent-home-card-v2-rose \.parent-home-card-v2-viewall \{ color: var\(--brand-dark\); \}/);
  // Every CTA button variant shares the same blue tokens now too.
  assert.match(
    css,
    /\.parent-home-cta-outline-amber,\s*\n\s*\.parent-home-cta-outline-purple,\s*\n\s*\.parent-home-cta-outline-blue,\s*\n\s*\.parent-home-cta-outline-indigo,\s*\n\s*\.parent-home-cta-outline-rose \{ background: transparent; border: 1\.5px solid var\(--brand\); color: var\(--brand-dark\); \}/
  );
  // None of the old one-off hex colors should remain on these selectors.
  assert.doesNotMatch(css, /\.parent-home-card-v2-green \{ background: #effaf3/);
  assert.doesNotMatch(css, /\.parent-home-card-v2-purple \{ background: #f6f0fc/);
  assert.doesNotMatch(css, /\.parent-home-cta-outline-amber \{ background: transparent; border: 1\.5px solid #c7912a/);
  assert.doesNotMatch(css, /\.parent-home-cta-outline-purple \{ background: transparent; border: 1\.5px solid #8148c2/);
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

// A real request: "Remove class registration card" - the per-child
// counts card this test used to cover is gone entirely now, not just
// changed; Classroom Dashboard is still reachable, just from the Classes
// nav group's own subpages instead of a homepage button.
test('Parent Portal homepage: Class Registrations card (with its per-child counts) is gone', async () => {
  const { cookie } = await loginAsPortalParent();
  const page = await request(app).get('/parent').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<h2>Class Registrations<\/h2>/);
  assert.doesNotMatch(page.text, /badge-pill-blue">\d+ classe?s?<\/span>/);
});

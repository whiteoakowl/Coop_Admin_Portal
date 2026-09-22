// A real request: "Blue drop down menus are not on every page. Check
// every portal, page and subpage." An audit of every place this app
// defines a subpages-bearing nav group (views/partials/admin-nav.ejs,
// views/partials/portal-nav.ejs, and the 5 Parent Portal views that pass
// the shared classLinks array) found the mechanism (public/js/page-
// tabs.js's own findCurrentSectionDialog, matching the current page's
// URL against a .page-tabs-dialog's own .view-tab links) already sound
// on every real portal page - this pins that down as a permanent
// regression test instead of a one-off manual check, covering all 69
// Co-op Admin + Main Admin subpage links plus Parent Portal's own
// Classes group. The two Classes subpages links that DON'T get a
// dropdown on their own page (Name Tag Form -> /name-tag, Absence/Late
// Form -> /absence) are a deliberate exception, same category page-
// tabs.js's own comment already documents for a class/event/member
// detail page: both are public, no-login, kiosk-shared self-service
// forms (routes/absence.js's own comment: "public, no-login endpoint"),
// never rendered inside any portal nav shell at all, kiosk touchscreen
// or portal alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `subpages-dropdown-audit-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `subpages-dropdown-audit-test-uploads-${process.pid}`);
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
const { generateMemberCode } = require('../utils/members');
const { hashPassword } = require('../utils/portalAuth');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

// Same extraction the audit itself used: every href inside a `subpages:
// [...]` array in either nav partial - the single source of truth for
// which pages are supposed to carry this dropdown.
function extractSubpageHrefs(src) {
  const subRe = /subpages:\s*\[([\s\S]*?)\]\s*\}/g;
  const all = [];
  let m;
  while ((m = subRe.exec(src))) {
    const hrefRe = /href:\s*'([^']+)'/g;
    let hm;
    while ((hm = hrefRe.exec(m[1]))) all.push(hm[1]);
  }
  return all;
}

// Replicates public/js/page-tabs.js's own findCurrentSectionDialog
// against server-rendered HTML: true if some .page-tabs-dialog's own
// .view-tab link resolves to this exact page (pathname + every query
// param the link itself carries).
function hasMatchingSubpagesDialog(html, href) {
  const target = new URL(href, 'http://x');
  const dialogRe = /<dialog class="[^"]*page-tabs-dialog[^"]*" id="mobile-subpages-[^"]*">([\s\S]*?)<\/dialog>/g;
  let dm;
  while ((dm = dialogRe.exec(html))) {
    const linkRe = /class="view-tab[^"]*" href="([^"]+)"/g;
    let lm;
    while ((lm = linkRe.exec(dm[1]))) {
      const linkUrl = new URL(lm[1], 'http://x');
      if (linkUrl.pathname !== target.pathname) continue;
      const params = Array.from(linkUrl.searchParams.entries());
      if (params.every(([k, v]) => target.searchParams.get(k) === v)) return true;
    }
  }
  return false;
}

function extractHead(html) {
  return /id="main-content"[\s\S]{0,3000}?<h1[\s>]/.test(html);
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: 'mainadmin@coop.local', password: 'changeme123', next: '/main-admin' });
  return loginRes.headers['set-cookie'];
}

async function loginAsParent() {
  const familyId = (await db.prepare('INSERT INTO families (name) VALUES (?)').run('Dropdown Audit Family')).lastInsertRowid;
  const parentCode = await generateMemberCode();
  const parentInfo = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, 'parent', ?, 1, 1)")
    .run('Dropdown Audit Parent', parentCode, parentCode, familyId);
  const email = 'dropdown-audit-parent@example.com';
  const accountInfo = await db
    .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text())")
    .run(parentInfo.lastInsertRowid, email, hashPassword('testpassword123'));
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountInfo.lastInsertRowid, parentRole.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/parent' });
  return loginRes.headers['set-cookie'];
}

test('Co-op Admin: every subpages-array link renders both an <h1> and a matching page-tabs-dialog', async () => {
  const cookie = await loginAsAdmin();
  const src = fs.readFileSync('views/partials/admin-nav.ejs', 'utf8');
  const hrefs = extractSubpageHrefs(src).filter((h) => h.startsWith('/admin/'));
  assert.ok(hrefs.length > 20, 'sanity check: expected a substantial number of Co-op Admin subpage links');
  for (const href of hrefs) {
    const res = await request(app).get(href).set('Cookie', cookie);
    assert.equal(res.status, 200, `${href} should render`);
    assert.ok(extractHead(res.text), `${href} should have an <h1> inside #main-content`);
    assert.ok(hasMatchingSubpagesDialog(res.text, href), `${href} should have a matching .page-tabs-dialog for the mobile "Menu" dropdown to attach to`);
  }
});

test('Main Admin: every subpages-array link renders both an <h1> and a matching page-tabs-dialog', async () => {
  const cookie = await loginAsMainAdmin();
  const src = fs.readFileSync('views/partials/portal-nav.ejs', 'utf8');
  const hrefs = extractSubpageHrefs(src).filter((h) => h.startsWith('/main-admin/'));
  assert.ok(hrefs.length > 30, 'sanity check: expected a substantial number of Main Admin subpage links');
  for (const href of hrefs) {
    const res = await request(app).get(href).set('Cookie', cookie);
    assert.equal(res.status, 200, `${href} should render`);
    assert.ok(extractHead(res.text), `${href} should have an <h1> inside #main-content`);
    assert.ok(hasMatchingSubpagesDialog(res.text, href), `${href} should have a matching .page-tabs-dialog for the mobile "Menu" dropdown to attach to`);
  }
});

test('Parent Portal Classes group: every real portal page in classLinks has a matching page-tabs-dialog', async () => {
  const cookie = await loginAsParent();
  // /name-tag and /absence are deliberately excluded - see this file's own
  // header comment (public, no-login, kiosk-shared forms outside any
  // portal nav shell).
  const hrefs = ['/parent/classes', '/parent/classes/manage', '/parent/classes/dashboard', '/parent/handbook'];
  for (const href of hrefs) {
    const res = await request(app).get(href).set('Cookie', cookie);
    assert.equal(res.status, 200, `${href} should render`);
    assert.ok(hasMatchingSubpagesDialog(res.text, href), `${href} should have a matching .page-tabs-dialog for the mobile "Menu" dropdown to attach to`);
  }
});

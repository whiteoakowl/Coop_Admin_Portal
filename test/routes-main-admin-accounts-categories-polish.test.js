// Coverage for a real request batch: "Main admin portal, accounts page...
// shrink table to fit mobile completely... remove description at the
// top." "Category/fiscal year page... There should be an edit button on
// categories and fiscal year lines... Delete description at top of
// page." "Portal choosing screen. Delete all descriptions. Each portal
// button is the title only and centered."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-accounts-categories-polish-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-accounts-categories-polish-test-uploads-${process.pid}`);
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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsMainAdmin() {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Accounts page: no description paragraph, and no search bar', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Every active member below, charge history or not/);
  // A real request: "remove search bar from accounts page."
  assert.doesNotMatch(page.text, /placeholder="Search member&hellip;"/);
  assert.doesNotMatch(page.text, /members-search-filter-row/);
  assert.match(page.text, /<div class="accounting-accounts-controls">[\s\S]*aria-label="Print Preview"[\s\S]*<\/div>/);
});

test('Accounts page: all orange buttons (+Invoice/+Payment/+Adjustment, Email All...) share one group so they sit on the same row on desktop', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting').set('Cookie', admin.cookie);
  assert.equal(page.status, 200);
  // A real request: "on desktop all orange buttons should be on the same
  // row next to each other" - +Invoice/+Payment/+Adjustment and the two
  // Email All buttons now share one .accounting-orange-buttons-group
  // wrapper (flex row on desktop, see public/css/styles.css), rather
  // than each living in its own unrelated row.
  assert.match(
    page.text,
    /<div class="accounting-orange-buttons-group">[\s\S]*\+ Invoice[\s\S]*\+ Payment[\s\S]*\+ Adjustment[\s\S]*Email All Past Due Invoices[\s\S]*Email All Invoices[\s\S]*<\/div>\s*<\/div>/
  );
});

test('Category/Fiscal Year page: no description paragraph, and each category/fiscal year row has a working Edit button', async () => {
  const admin = await loginAsMainAdmin();
  const page = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.doesNotMatch(page.text, /A fixed list an event's Finance tab/);

  await request(app)
    .post('/main-admin/accounting/accounting-categories')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Original Category', code: 'OC', _csrf: admin.csrfToken });
  const category = await db.prepare("SELECT * FROM event_accounting_categories WHERE name = 'Original Category'").get();

  await request(app)
    .post('/main-admin/accounting/fiscal-years')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ startDate: '2026-07-01', endDate: '2027-06-30', _csrf: admin.csrfToken });
  const fiscalYear = await db.prepare('SELECT * FROM fiscal_years').get();

  const withRows = await request(app).get('/main-admin/accounting/categories').set('Cookie', admin.cookie);
  assert.match(withRows.text, new RegExp(`document\\.getElementById\\('edit-category-dialog-${category.id}'\\)\\.showModal`));
  assert.match(withRows.text, new RegExp(`document\\.getElementById\\('edit-fiscal-year-dialog-${fiscalYear.id}'\\)\\.showModal`));
  // The old always-editable, auto-submitting inputs are gone - plain text
  // + an Edit button/dialog instead (also what fixed the mobile overflow).
  assert.doesNotMatch(withRows.text, /onchange="this\.form\.submit\(\)"/);

  await request(app)
    .post(`/main-admin/accounting/accounting-categories/${category.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ name: 'Renamed Category', code: 'RC', _csrf: admin.csrfToken });
  const renamed = await db.prepare('SELECT * FROM event_accounting_categories WHERE id = ?').get(category.id);
  assert.equal(renamed.name, 'Renamed Category');
  assert.equal(renamed.code, 'RC');

  // Fiscal years only had add/delete before this - update is new.
  await request(app)
    .post(`/main-admin/accounting/fiscal-years/${fiscalYear.id}/update`)
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ startDate: '2027-07-01', endDate: '2028-06-30', _csrf: admin.csrfToken });
  const updatedFy = await db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(fiscalYear.id);
  assert.equal(updatedFy.start_date, '2027-07-01');
  assert.equal(updatedFy.end_date, '2028-06-30');
});

// A later real request ("Add description under each portal title. On
// choose portal page...") brought a description back under each card's
// title (views/portal-switcher.ejs's own role.description), with the
// user's own exact wording per portal (db/bootstrapPg.js's own
// PORTAL_ROLES) - this test's own name/assertions were updated to match;
// see test/portal-chat-dual-role-and-training.test.js for full coverage
// of the new wording itself.
test('Portal switcher (2+ roles): centered title cards, each with its own description', async () => {
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('SwitcherFamily') RETURNING id").get()).id;
  const code = await generateMemberCode();
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Switcher Parent', ?, ?, 'parent', ?, 1) RETURNING id")
      .get(code, code, familyId)
  ).id;
  const email = 'switcher-parent@example.com';
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const parentRole = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const teacherRole = await db.prepare("SELECT id FROM roles WHERE key = 'teacher'").get();
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, parentRole.id);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, teacherRole.id);

  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: '/portal' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/portal').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Choose a portal to continue/);
  assert.match(page.text, /portal-picker-title/);
  assert.match(page.text, /<span class="portal-picker-description">Class registration, event registration, family homeschool management, etc\.<\/span>/);
  assert.match(page.text, /<span class="portal-picker-description">Attendance, manage classes\. Lesson plans\. Etc\.<\/span>/);
});

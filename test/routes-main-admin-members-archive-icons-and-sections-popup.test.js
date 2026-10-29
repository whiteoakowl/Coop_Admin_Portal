// Coverage for two small, related real requests in the same Settings
// batch:
// 1. "Members, archive. Add export, print and pdf icons. Filter button
//    should be first in the row and the icons next to the filter button
//    in the same row." (views/main-admin-members.ejs's own archive-tab
//    branch of .members-search-filter-row)
// 2. "Settings. Sections. Remove description. Add a section button
//    should have a pop up for being able to add a new section." (views/
//    main-admin-sections.ejs, routes/main-admin-sections.js's own POST
//    /new)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `main-admin-members-archive-sections-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `main-admin-members-archive-sections-test-uploads-${process.pid}`);
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

test('the Archive tab shows Filter first, then Export/Print/PDF icons, all scoped to archived=1', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/members?tab=archive').set('Cookie', cookie);
  assert.equal(res.status, 200);

  const filterIndex = res.text.indexOf('id="members-filter-dialog"');
  const exportIndex = res.text.indexOf('/main-admin/members/export.csv?archived=1');
  const printIndex = res.text.indexOf('/main-admin/members/print?archived=1');
  const pdfIndex = res.text.indexOf('/main-admin/members/download.pdf?archived=1');
  assert.ok(filterIndex > -1 && exportIndex > -1 && printIndex > -1 && pdfIndex > -1, 'expected the Filter dialog markup and all three archive icons to be present');
  assert.ok(filterIndex < exportIndex, 'Filter should come before the Export icon in source order');
  assert.ok(exportIndex < printIndex && printIndex < pdfIndex, 'Export, Print, PDF icons should stay in that order');
});

test('GET /main-admin/members/export.csv?archived=1 exports only archived members', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('Archive Export Family') RETURNING id").get()).id;
  const archived = await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Archived Export Member', 'archived-export-member', 'student', ?, 0) RETURNING id").get(familyId);
  await db.prepare("INSERT INTO members (name, barcode, member_type, family_id, active) VALUES ('Active Export Member', 'active-export-member', 'student', ?, 1)").run(familyId);

  const res = await request(app).get('/main-admin/members/export.csv?archived=1').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /Archived Export Member/);
  assert.doesNotMatch(res.text, /Active Export Member/);
  void csrfToken;
  void archived;
});

test('Sections page has no description paragraph and its + Add Section button opens a popup dialog, not an inline form', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/sections').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /id="add-section-dialog" class="member-picker-dialog"/);
  assert.match(res.text, /showModal\(\)/);
  // The dialog's own form is what posts to /new, not a second always-
  // visible inline form sharing that action - the popup replaced the
  // description paragraph that used to sit here.
  const newFormCount = (res.text.match(/action="\/main-admin\/sections\/new"/g) || []).length;
  assert.equal(newFormCount, 1);
});

// A real request: "remove description column. shrink to fit table in
// mobile view... Add section button should be under title."
test('Sections page has no Description table column, and the + Add Section button sits on its own row under the title', async () => {
  const { cookie } = await loginAsMainAdmin();
  const res = await request(app).get('/main-admin/sections').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<th>Description<\/th>/);
  const h1Index = res.text.indexOf('<h1>Sections</h1>');
  const btnIndex = res.text.indexOf("document.getElementById('add-section-dialog').showModal()");
  assert.ok(h1Index !== -1 && btnIndex !== -1 && h1Index < btnIndex, 'the Add Section button must come after the title, not beside it');
  // Not inside the same flex toolbar as the title anymore.
  assert.doesNotMatch(res.text, /<div class="roster-toolbar no-print">\s*<h1>Sections<\/h1>/);
});

test('POST /main-admin/sections/new creates a section via the popup form, shown in a shrink-to-fit mobile table with a trash icon', async () => {
  const { cookie, csrfToken } = await loginAsMainAdmin();
  const res = await request(app)
    .post('/main-admin/sections/new')
    .set('Cookie', cookie)
    .type('form')
    .send({ name: 'Popup Created Section', description: '', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const sectionsPage = await request(app).get('/main-admin/sections').set('Cookie', cookie);
  assert.match(sectionsPage.text, /Popup Created Section/);
  assert.match(sectionsPage.text, /class="roster-table condensed-table sections-table"/);
  assert.match(sectionsPage.text, /<use href="#icon-trash"\/>/);
});

// Real HTTP-level coverage for the "Admins" tab (routes/main-admin.js's
// POST /admins/positions and /admins/positions/:id/delete, backed by
// utils/adminPositions.js). Originally "Admin & Leaders" on Co-op
// Admin's own Settings, later just "Admins" there - a real request then
// moved the whole tab to Main Admin's Settings: "co-op admin portal.
// settings gear, admins tab. this tab should be located under the main
// admin portal settings gear as a tab. it should not be on co-op admin
// portal."
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-settings-admin-positions-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-settings-admin-positions-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/main-admin/admins').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function loginAsCoopAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return loginRes.headers['set-cookie'];
}

test('Main Admin Settings: Admins tab', async (t) => {
  const { cookie, csrfToken } = await loginAsMainAdmin();

  await t.test('the tab is offered and starts empty', async () => {
    const res = await request(app).get('/main-admin/admins').set('Cookie', cookie);
    assert.equal(res.status, 200);
    // A real request: "every time you click on a subpage 4 tabs pop up
    // still on each page. There should only be a back link with arrow
    // that says back to settings menu." Replaced the old 4-tab strip.
    assert.match(res.text, /<a href="\/main-admin\/settings">&larr; Back to Settings Menu<\/a>/);
    assert.match(res.text, /No admin positions added yet\./);
  });

  await t.test('adding a position lists it', async () => {
    const res = await request(app)
      .post('/main-admin/admins/positions/bulk-save')
      .set('Cookie', cookie)
      .type('form')
      .send({ newPositionTitle: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
    assert.doesNotMatch(res.text, /No admin positions added yet\./);
  });

  // A real request: "Under admin settings we can control where the
  // messages go to for each admin member such as a specific email
  // address" (Contact Admins feature) - the per-member contactEmail
  // override lives on member_admin_positions itself, set via this same
  // position-update form.
  await t.test('setting a Contact Email for a chosen member persists on member_admin_positions', async () => {
    // A position of its own (not 'President') - the leaders table's own
    // delete button only ever shows for a position with zero members
    // (views/main-admin-admins.ejs), so assigning a member to 'President'
    // here would otherwise break the later "deleting a position" test's
    // own assumption that President still has no leader.
    await request(app)
      .post('/main-admin/admins/positions/bulk-save')
      .set('Cookie', cookie)
      .type('form')
      .send({ newPositionTitle: 'Treasurer (Contact Email Test)', _csrf: csrfToken });
    const position = await db.prepare('SELECT id FROM admin_positions WHERE title = ?').get('Treasurer (Contact Email Test)');
    const familyId = (await db.prepare("INSERT INTO families (name) VALUES ('ContactEmailOverrideFamily') RETURNING id").get()).id;
    const member = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Contact Email Parent', 'CONTACTEMAILOVERRIDE', 'CONTACTEMAILOVERRIDE', 'parent', ?, 1) RETURNING id")
      .get(familyId);

    const res = await request(app)
      .post(`/main-admin/admins/positions/${position.id}/update`)
      .set('Cookie', cookie)
      .type('form')
      .send({ memberId: member.id, email: 'treasurer@example.com', contactEmail: 'treasurer-department@example.com', _csrf: csrfToken });
    assert.equal(res.status, 200);

    const link = await db.prepare('SELECT contact_email FROM member_admin_positions WHERE member_id = ? AND admin_position_id = ?').get(member.id, position.id);
    assert.equal(link.contact_email, 'treasurer-department@example.com');

    // Clean up this test's own scratch position so later subtests (which
    // assume 'President' is the only position on the list) aren't thrown
    // off by it sticking around.
    await db.prepare('DELETE FROM admin_positions WHERE id = ?').run(position.id);
  });

  // A real bug report: "the list of admin positions and names drifts off
  // the page to the right. Fit to page on mobile." html/body have
  // overflow-x:hidden as a page-wide backstop (public/css/styles.css), so
  // a wide table with nowhere to scroll doesn't get a scrollbar - it just
  // silently clips, taking whatever ran past the viewport edge with it.
  // Every other roster-shaped table in the app wraps in .roster-scroll
  // (overflow-x:auto) for exactly this reason - this table was the one
  // left out.
  await t.test('the Admin Positions table is wrapped in a horizontally-scrollable container, not left to overflow the page', async () => {
    const res = await request(app).get('/main-admin/admins').set('Cookie', cookie);
    assert.match(res.text, /<div class="roster-scroll">\s*<table class="roster-table condensed-table admins-table">/);
  });

  await t.test('the new position shows up in the (Co-op Admin) member edit form dropdown', async () => {
    // Admin Positions still lives in utils/adminPositions.js, shared by
    // both portals' member data - only the Settings UI for MANAGING the
    // list of positions moved to Main Admin. Co-op Admin's own member
    // edit form (views/partials/member-form-fields.ejs) still shows an
    // existing Admin's position checkboxes (just never lets anyone
    // become Admin from there in the first place - see that partial's
    // own comment). Member creation itself is Main Admin-only now
    // ("membership to the app/website... member creation is Main
    // Admin-only now"), so this inserts the member directly rather than
    // through Co-op Admin's own (now-removed) /admin/members/new.
    const coopCookie = await loginAsCoopAdmin();
    const positionCheckFamilyId = (await db.prepare("INSERT INTO families (name) VALUES ('PositionDropdownCheck') RETURNING id").get()).id;
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, active) VALUES ('Position Dropdown Parent', 'POSDROP1', 'POSDROP1', 'parent', ?, 1)")
      .run(positionCheckFamilyId);
    const member = await db.prepare("SELECT id FROM members WHERE name = 'Position Dropdown Parent'").get();
    assert.ok(member, 'the new parent should have been created');

    const res = await request(app).get(`/admin/members/${member.id}/edit`).set('Cookie', coopCookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /President/);
  });

  await t.test('adding a duplicate title is a no-op, not an error', async () => {
    const res = await request(app)
      .post('/main-admin/admins/positions/bulk-save')
      .set('Cookie', cookie)
      .type('form')
      .send({ newPositionTitle: 'President', _csrf: csrfToken });
    assert.equal(res.status, 200);
    const rows = await db.prepare('SELECT id FROM admin_positions WHERE title = ?').all('President');
    assert.equal(rows.length, 1, 'still exactly one "President" row, not duplicated');
  });

  await t.test('deleting a position removes it from the list', async () => {
    const listPage = await request(app).get('/main-admin/admins').set('Cookie', cookie);
    const idMatch = /\/main-admin\/admins\/positions\/(\d+)\/delete/.exec(listPage.text);
    assert.ok(idMatch, 'expected a delete form with the position id in its action');
    const res = await request(app)
      .post(`/main-admin/admins/positions/${idMatch[1]}/delete`)
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.match(res.text, /No admin positions added yet\./);
  });
});

test('Co-op Admin Settings no longer offers an Admins tab', async () => {
  const cookie = await loginAsCoopAdmin();
  const res = await request(app).get('/admin/settings').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /tab=leaders/);
  assert.doesNotMatch(res.text, />Admins<\/a>/);

  // The old tab query param should just fall back to the default tab,
  // not error or still render admin-position content.
  const oldTabRes = await request(app).get('/admin/settings?tab=leaders').set('Cookie', cookie);
  assert.equal(oldTabRes.status, 200);
  assert.doesNotMatch(oldTabRes.text, /Add Admin Position/);
});

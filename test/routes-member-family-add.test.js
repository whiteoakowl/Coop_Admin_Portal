// Real HTTP-level coverage for a bug report this session: the Add/Edit
// Member form's "Choose a Family" box used to show a <select> *and* a
// redundant checklist of button rows underneath it, both picking the same
// single value - "check boxes for choosing a family" the user asked to
// have removed, leaving just the dropdown plus a way to add a new family
// without leaving the page. This suite covers the route half of that fix:
// POST /admin/members/families/new now branches on Accept, same convention
// as routes/admin-class-schedule.js's roster/add route, so the "+ Add New
// Family" dialog (public/js/member-form.js) can create a family via fetch
// and get back {id, name} to insert into the <select> in place, instead of
// following the plain-form redirect back to /admin/members (which would
// have discarded whatever else was already typed into the member form).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `member-family-add-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `member-family-add-test-uploads-${process.pid}`);
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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/members/new').set('Cookie', cookie);
  const match = /name="csrf-token" content="([^"]*)"/.exec(page.text);
  return { cookie, csrfToken: match ? match[1] : null };
}

test('the Edit Member form has a single family dropdown, no duplicate checklist', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('/admin/members/:id/edit renders the select and Add New Family button, not the old checklist', async () => {
    // Add Member ("there shouldn't be any lone admins/leaders, or single
    // members") now only creates members through the whole-family intake
    // form at /admin/members/new (views/member-intake-form.ejs), which
    // has its own plain <select>/<input> "Choose a Family" box - no
    // dialog at all. This test's dialog-based "Choose a Family" markup
    // (public/js/member-form.js's "+ Add New Family" popup) still lives
    // on the EDIT form only (views/admin-member-edit.ejs via views/
    // partials/member-form-fields.ejs), so it's covered there instead.
    await request(app)
      .post('/admin/members/new')
      .set('Cookie', cookie)
      .type('form')
      .send({
        newFamilyName: 'EditFormCheck',
        'parents[0][name]': 'Edit Form Parent',
        'children[0][name]': 'Edit Form Kid',
        _csrf: csrfToken,
      });
    const member = await db.prepare("SELECT id FROM members WHERE name = 'Edit Form Parent'").get();

    const res = await request(app).get(`/admin/members/${member.id}/edit`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /data-family-select/);
    assert.match(res.text, /data-add-family-open/);
    assert.match(res.text, /data-add-family-dialog/);
    assert.doesNotMatch(res.text, /data-family-checklist/, 'the redundant family checkbox/checklist rows should be gone');
    assert.doesNotMatch(res.text, /data-family-option/);
  });
});

test('POST /admin/members/families/new', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await t.test('a fetch-style (Accept: application/json) request gets back the new family as JSON, not a redirect', async () => {
    const res = await request(app)
      .post('/admin/members/families/new')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .type('form')
      .send({ name: 'Anderson', _csrf: csrfToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Anderson');
    assert.ok(Number.isInteger(res.body.id), 'expected a numeric family id back');
  });

  await t.test('a duplicate family name (JSON request) is rejected with 409 and an error body, not a redirect', async () => {
    const res = await request(app)
      .post('/admin/members/families/new')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .type('form')
      .send({ name: 'anderson', _csrf: csrfToken }); // case-insensitive match
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already exists/);
  });

  await t.test('a blank name (JSON request) is rejected with 400', async () => {
    const res = await request(app)
      .post('/admin/members/families/new')
      .set('Cookie', cookie)
      .set('Accept', 'application/json')
      .type('form')
      .send({ name: '  ', _csrf: csrfToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /required/);
  });

  await t.test('a plain (non-JSON) form submission still redirects back to /admin/members, unchanged behavior', async () => {
    const res = await request(app)
      .post('/admin/members/families/new')
      .set('Cookie', cookie)
      .type('form')
      .send({ name: 'Baker', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/members\?notice=/);
  });
});

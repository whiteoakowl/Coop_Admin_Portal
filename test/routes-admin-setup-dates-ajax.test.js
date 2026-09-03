// Coverage for a real request: "when adding dates to setup/cleanup it
// should stay on the pop up and simply immediately update the list with
// the new date and allow you to continue adding dates while window is
// still open. same if clicking remove a date, the date should disappear
// and pop up stay open for further editing and adding." routes/admin-
// setup.js's dates/add and dates/:date/remove routes now render the
// Edit Session Dates dialog's own list back as HTML (setup-dates-
// fragment.ejs) for a fetch caller (public/js/setup-dates.js sends
// X-Requested-With: fetch) instead of redirecting - a plain, non-fetch
// form submit still gets the original redirect, covered here too so
// neither path regressed for the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-dates-ajax-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-dates-ajax-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

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
  const page = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('POST .../dates/add from a fetch caller returns the dialog\'s date list HTML instead of redirecting', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/setup/monday/dates/add')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ dates: '2027-03-08', _csrf: csrfToken });

  assert.equal(res.status, 200, 'a fetch caller should get the fragment back, not a 302 redirect');
  assert.match(res.text, /roster-table members-table condensed-table/, 'should render the same dialog list markup');
  assert.match(res.text, /Mon 3\/8\/27|3\/8/, 'the newly added date should already be in the returned list');
  assert.doesNotMatch(res.text, /<!doctype html>/i, 'a fragment response should not be a full page');
});

test('POST .../dates/add without the fetch header still redirects (plain form submit, JS disabled)', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const res = await request(app)
    .post('/admin/setup/monday/dates/add')
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: '2027-03-15', _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/setup\/monday\/assignments\?notice=/);
});

test('POST .../dates/:date/remove from a fetch caller removes the date and returns the updated list HTML', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post('/admin/setup/monday/dates/add')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ dates: '2027-04-05', _csrf: csrfToken });

  const res = await request(app)
    .post('/admin/setup/monday/dates/2027-04-05/remove')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /4\/5\/27/, 'the removed date should no longer be in the returned list');
});

test('POST .../dates/:date/remove without the fetch header still redirects', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post('/admin/setup/monday/dates/add')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ dates: '2027-04-12', _csrf: csrfToken });

  const res = await request(app)
    .post('/admin/setup/monday/dates/2027-04-12/remove')
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/setup\/monday\/assignments\?notice=/);
});

test('Edit Session Dates dialog markup: the date list and Add Dates form are both inside #edit-dates-dialog, so client-side event delegation scoped to the dialog catches both', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const dialogMatch = /<dialog id="edit-dates-dialog"[^]*?<\/dialog>/.exec(res.text);
  assert.ok(dialogMatch, 'expected the Edit Session Dates dialog in the page');
  const dialogHtml = dialogMatch[0];
  assert.match(dialogHtml, /id="setup-dates-list"/);
  assert.match(dialogHtml, /class="volunteer-date-add-form"/);
});

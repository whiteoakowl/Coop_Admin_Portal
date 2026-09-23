// A real request: "Floater assignments, choose date drop down should
// show all of the dates so far until you click an archive button for
// each date." A session date used to fall off the manage page's own
// Choose Date dropdown (and onto the read-only Archive tab) automatically
// the moment it was no longer today or later - utils/volunteers.js's
// archiveDate/unarchiveDate/activeDatesForList/archivedDatesForList, and
// routes/admin-volunteers.js's own /dates/:date/archive and
// /archive/:date/unarchive, replace that with an explicit per-date admin
// action instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-date-archiving-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-date-archiving-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { getListByDay } = require('../utils/volunteers');

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
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function addDate(cookie, csrfToken, day, date) {
  await request(app).post(`/admin/volunteers/${day}/dates/add`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken, dates: date });
}

test('a past, never-archived date still shows on the manage page\'s Choose Date dropdown', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const pastDate = '2020-01-06'; // a real past Monday
  await addDate(cookie, csrfToken, 'monday', pastDate);

  const res = await request(app).get(`/admin/volunteers/monday/manage?date=${pastDate}`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  const selectHtml = /<select id="chart-date-select"[\s\S]*?<\/select>/.exec(res.text)[0];
  assert.match(selectHtml, new RegExp(`value="${pastDate}"[^>]*selected`), 'a past date should still be selectable until it is explicitly archived');
});

test('archiving a date via the Edit Dates dialog removes it from the Choose Date dropdown and moves it to the Archive tab', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const day = 'wednesday';
  const date = '2020-01-08'; // a real past Wednesday
  await addDate(cookie, csrfToken, day, date);

  const list = await getListByDay(day);
  const before = await db.prepare('SELECT archived_at FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').get(list.id, date);
  assert.equal(before.archived_at, null);

  const archiveRes = await request(app)
    .post(`/admin/volunteers/${day}/dates/${date}/archive?dialog=dates`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(archiveRes.status, 302);
  assert.match(archiveRes.headers.location, /dialog=dates/, 'the redirect should reopen the Edit Dates dialog');

  const after = await db.prepare('SELECT archived_at FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').get(list.id, date);
  assert.ok(after.archived_at, 'the row should now carry an archived_at timestamp');

  const manageRes = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const selectHtml = /<select id="chart-date-select"[\s\S]*?<\/select>/.exec(manageRes.text)[0];
  assert.doesNotMatch(selectHtml, new RegExp(`value="${date}"`), 'an archived date must not appear in the Choose Date dropdown');

  const archiveTabRes = await request(app).get(`/admin/volunteers/${day}/archive`).set('Cookie', cookie);
  assert.match(archiveTabRes.text, /2020|January 8/, 'the archived date should now show up on the Archive tab');
});

test('the Edit Dates dialog labels an archived date and only shows Archive for still-active ones', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const day = 'monday';
  const activeDate = '2020-01-13';
  const archivedDate = '2020-01-20';
  await addDate(cookie, csrfToken, day, activeDate);
  await addDate(cookie, csrfToken, day, archivedDate);
  await request(app).post(`/admin/volunteers/${day}/dates/${archivedDate}/archive`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const res = await request(app).get(`/admin/volunteers/${day}/manage`).set('Cookie', cookie);
  const dialogHtml = /<dialog id="edit-dates-dialog"[\s\S]*?<\/dialog>/.exec(res.text)[0];
  assert.match(dialogHtml, /\(archived\)/, 'the archived row should be labeled');
  assert.match(
    dialogHtml,
    new RegExp(`/admin/volunteers/${day}/dates/${activeDate}/archive\\?dialog=dates`),
    'the still-active date should have its own Archive button'
  );
  assert.doesNotMatch(
    dialogHtml,
    new RegExp(`/admin/volunteers/${day}/dates/${archivedDate}/archive\\?dialog=dates`),
    'an already-archived date should not offer Archive again'
  );
});

test('restoring an archived date from the Archive tab puts it back on the manage page\'s dropdown', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const day = 'wednesday';
  const date = '2020-02-05';
  await addDate(cookie, csrfToken, day, date);
  await request(app).post(`/admin/volunteers/${day}/dates/${date}/archive`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const restoreRes = await request(app)
    .post(`/admin/volunteers/${day}/archive/${date}/unarchive`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(restoreRes.status, 302);
  assert.match(restoreRes.headers.location, new RegExp(`/admin/volunteers/${day}/archive`));

  const list = await getListByDay(day);
  const row = await db.prepare('SELECT archived_at FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').get(list.id, date);
  assert.equal(row.archived_at, null, 'unarchiving should clear archived_at');

  const manageRes = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const selectHtml = /<select id="chart-date-select"[\s\S]*?<\/select>/.exec(manageRes.text)[0];
  assert.match(selectHtml, new RegExp(`value="${date}"`), 'the restored date should be selectable again');
});

test('the read-only Archive view/print/export routes only work for an explicitly archived date, not merely a past one', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const day = 'monday';
  const stillActivePastDate = '2020-03-02';
  await addDate(cookie, csrfToken, day, stillActivePastDate);

  const beforeArchive = await request(app).get(`/admin/volunteers/${day}/archive/${stillActivePastDate}/view-fragment`).set('Cookie', cookie);
  assert.equal(beforeArchive.status, 404, 'a merely-past, still-active date must not be readable through the read-only Archive routes');

  await request(app).post(`/admin/volunteers/${day}/dates/${stillActivePastDate}/archive`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const afterArchive = await request(app).get(`/admin/volunteers/${day}/archive/${stillActivePastDate}/view-fragment`).set('Cookie', cookie);
  assert.equal(afterArchive.status, 200, 'once explicitly archived, the same date should be readable');
});

test('removing a date (not archiving it) deletes it outright, regardless of archived status', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const day = 'wednesday';
  const date = '2020-04-01';
  await addDate(cookie, csrfToken, day, date);
  await request(app).post(`/admin/volunteers/${day}/dates/${date}/archive`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  await request(app).post(`/admin/volunteers/${day}/dates/${date}/remove`).set('Cookie', cookie).type('form').send({ _csrf: csrfToken });

  const list = await getListByDay(day);
  const row = await db.prepare('SELECT * FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').get(list.id, date);
  assert.equal(row, undefined, 'Remove should delete the row entirely even though it had been archived');
});

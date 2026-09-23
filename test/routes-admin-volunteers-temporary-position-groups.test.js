// Coverage for the Floater Assignments "Add/Edit Temporary Position"
// dialog (a real request: "Add a button on floater assignment page that
// is just like the add/edit permanent position button. Except this will
// be called add/edit temporary position. Same popup and format. However,
// when a job is added using this temporary button the job is only
// available that day.") - utils/substitutes.js's
// temporaryJobsForDayDate/groupedTemporaryJobsForDayDate/
// saveTemporaryPositionGroup, and routes/admin-substitutes.js's
// /temporary-jobs/save-groups POST.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-temp-position-groups-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-temp-position-groups-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function addSessionDate(cookie, csrfToken, day, date) {
  await request(app)
    .post(`/admin/volunteers/${day}/dates/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, dates: date });
}

test('the manage page has a "+ Add/Edit Temporary Position" button', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  assert.match(res.text, /\+ Add\/Edit Temporary Position/);
});

test('saving a temporary position creates a permanent_jobs row scoped to that date only, invisible to the recurring dialog', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const today = new Date().toISOString().slice(0, 10);
  await addSessionDate(cookie, csrfToken, 'monday', today);

  await request(app)
    .post('/admin/volunteers/monday/substitutes/temporary-jobs/save-groups')
    .set('Cookie', cookie)
    .type('form')
    .send({
      _csrf: csrfToken,
      date: today,
      groups: { new: { title: 'Field Trip Chaperone', room: '', hours: ['1'] } },
    });

  const row = await db.prepare("SELECT * FROM permanent_jobs WHERE title = 'Field Trip Chaperone'").get();
  assert.ok(row, 'the temporary position should have been inserted');
  assert.equal(row.session_date, today, 'it should be scoped to the date it was created for');

  // permanentJobsForDay filters session_date IS NULL, so this must never
  // leak into the recurring Add/Edit Position dialog's own group list.
  const res = await request(app).get(`/admin/volunteers/monday/manage?date=${today}`).set('Cookie', cookie);
  const permanentDialog = /<dialog id="add-job-dialog"[\s\S]*?<\/dialog>/.exec(res.text)[0];
  assert.doesNotMatch(permanentDialog, /Field Trip Chaperone/, 'a temporary position must not show up in the permanent Add/Edit Position dialog');

  const tempDialog = /<dialog id="add-temp-job-dialog"[\s\S]*?<\/dialog>/.exec(res.text)[0];
  assert.match(tempDialog, /value="Field Trip Chaperone"/, 'it should show up in its own temporary-position dialog');
});

test('a temporary position appears on the floater chart for its own date but not for a different date of the same weekday', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const dateA = '2026-10-05'; // a Monday
  const dateB = '2026-10-12'; // the following Monday
  await addSessionDate(cookie, csrfToken, 'monday', dateA);
  await addSessionDate(cookie, csrfToken, 'monday', dateB);

  await request(app)
    .post('/admin/volunteers/monday/substitutes/temporary-jobs/save-groups')
    .set('Cookie', cookie)
    .type('form')
    .send({
      _csrf: csrfToken,
      date: dateA,
      groups: { new: { title: 'One-Day Setup Help', room: '4', hours: ['1'] } },
    });

  const resA = await request(app).get(`/admin/volunteers/monday/manage?date=${dateA}`).set('Cookie', cookie);
  assert.match(resA.text, /One-Day Setup Help/, 'the temporary position should appear on the chart for the date it was created for');
  assert.match(resA.text, /Temporary Position/, 'it should be labeled as a Temporary Position, distinct from a recurring one');

  const resB = await request(app).get(`/admin/volunteers/monday/manage?date=${dateB}`).set('Cookie', cookie);
  assert.doesNotMatch(resB.text, /One-Day Setup Help/, 'it must not appear on a different date, even the same weekday');
});

test('deleting a temporary position group removes only that date\'s rows and reopens the temp dialog', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const today = new Date().toISOString().slice(0, 10);
  await addSessionDate(cookie, csrfToken, 'monday', today);

  await request(app)
    .post('/admin/volunteers/monday/substitutes/temporary-jobs/save-groups')
    .set('Cookie', cookie)
    .type('form')
    .send({
      _csrf: csrfToken,
      date: today,
      groups: { new: { title: 'Temp Job To Delete', room: '', hours: ['1', '2'] } },
    });

  const row = await db.prepare("SELECT * FROM permanent_jobs WHERE title = 'Temp Job To Delete'").get();
  assert.ok(row);

  const res = await request(app)
    .post(`/admin/volunteers/monday/substitutes/temporary-jobs/group/${row.id}/delete`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, date: today });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /dialog=temp-job/, 'the redirect should reopen the temporary-position dialog');

  const remaining = await db.prepare("SELECT * FROM permanent_jobs WHERE title = 'Temp Job To Delete'").all();
  assert.equal(remaining.length, 0, 'both hour rows for the deleted temporary position should be gone');
});

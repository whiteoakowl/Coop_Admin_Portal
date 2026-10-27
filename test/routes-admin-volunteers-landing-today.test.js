// A real bug report: "It shows a teacher absent today when they did not
// submit a form for today. They were absent another date" - confirmed by
// the reporter to be on the Floater/Substitute Assignments board. Root
// cause: the sidebar's own "Floater Assignments" nav link
// (views/partials/admin-nav.ejs) points at the bare /admin/volunteers,
// whose old redirect always landed on whichever active class day sorted
// FIRST in the week (e.g. always Monday) with no regard for what day it
// actually is. On any OTHER day, an admin clicking that link landed on a
// different day's board entirely, which then defaults to ITS OWN most
// recent/next date (see that route's own defaultDate comment) - a date
// that can carry a real absence from a teacher who was genuinely out
// THAT day, displayed with nothing making clear it isn't today. Fixed by
// preferring today's own active day when today is one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-landing-today-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-landing-today-test-uploads-${process.pid}`);
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
  return loginRes.headers['set-cookie'];
}

test('clicking the sidebar\'s "Floater Assignments" link lands on TODAY\'s own active day, not just whichever day sorts first in the week', async (t) => {
  const cookie = await loginAsAdmin();

  // Monday and Wednesday are both already seeded as active class days by
  // the default migrations - Monday sorts first in calendar order, which
  // is exactly what the old code always redirected to regardless of what
  // day it actually is.

  await t.test('today is Wednesday (not the first-in-week active day) - lands on Wednesday, not Monday', async () => {
    // 2024-07-10T16:00:00Z = 12:00 PM EDT on a real Wednesday.
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-07-10T16:00:00Z').getTime() });
    try {
      const res = await request(app).get('/admin/volunteers').set('Cookie', cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/admin/volunteers/wednesday/manage');
    } finally {
      t.mock.timers.reset();
    }
  });

  await t.test('today is Monday - lands on Monday, same as always', async () => {
    // 2024-07-08T16:00:00Z = 12:00 PM EDT on a real Monday.
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-07-08T16:00:00Z').getTime() });
    try {
      const res = await request(app).get('/admin/volunteers').set('Cookie', cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/admin/volunteers/monday/manage');
    } finally {
      t.mock.timers.reset();
    }
  });

  await t.test('today is Tuesday - not an active day at all, so falls back to the first-in-week active day exactly as before', async () => {
    // 2024-07-09T16:00:00Z = 12:00 PM EDT on a real Tuesday.
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2024-07-09T16:00:00Z').getTime() });
    try {
      const res = await request(app).get('/admin/volunteers').set('Cookie', cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/admin/volunteers/monday/manage');
    } finally {
      t.mock.timers.reset();
    }
  });
});

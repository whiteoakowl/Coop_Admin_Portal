// Real HTTP-level coverage for GET /volunteers/:day - the public, no-login
// kiosk floater-assignment chart linked from the site's own landing page
// (views/index.ejs's "Floater Assignments" card) and the full kiosk
// screen (views/kiosk-home.ejs). Previously had zero test coverage at
// all, which is exactly how a real crash on this route (deployed to
// Netlify, a request landing before first-boot seeding had finished -
// see netlify/functions/app.js's own header comment) went unnoticed:
// getListByDay(day) returning undefined and the route reading `.id` off
// it unguarded threw a TypeError instead of a clean response. This
// mirrors every other getListByDay call site in the codebase, all of
// which already guard against exactly this.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-volunteers-public-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-volunteers-public-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('GET /volunteers/:day', async (t) => {
  await t.test('an invalid day 404s', async () => {
    const res = await request(app).get('/volunteers/tuesday');
    assert.equal(res.status, 404);
  });

  await t.test('a valid day with no floater list scheduled today shows the muted "no assignments" panel', async () => {
    const res = await request(app).get('/volunteers/monday');
    assert.equal(res.status, 200);
    assert.match(res.text, /No floater assignments for today\./);
  });

  await t.test('a missing volunteer_lists row for an otherwise-valid day 404s instead of crashing', async () => {
    // Simulates the real startup-race bug this test file exists to lock
    // in: a request landing before db/bootstrapPg.js's first-boot seeding
    // has created this day's row. Deleting it directly reproduces the
    // same "row doesn't exist yet" state without needing to actually race
    // real boot timing.
    await db.prepare("DELETE FROM volunteer_lists WHERE day = 'wednesday'").run();
    const res = await request(app).get('/volunteers/wednesday');
    assert.equal(res.status, 404);
  });
});

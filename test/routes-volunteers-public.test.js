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

  await t.test('a valid day with no upcoming floater dates shows the muted "no assignments" panel', async () => {
    const res = await request(app).get('/volunteers/monday');
    assert.equal(res.status, 200);
    assert.match(res.text, /No upcoming floater assignments\./);
  });

  await t.test('a day picker is offered at the bare /volunteers route, linking into both days', async () => {
    const res = await request(app).get('/volunteers');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/volunteers\/monday"/);
    assert.match(res.text, /href="\/volunteers\/wednesday"/);
  });

  await t.test('a real request: with nothing scheduled today but a date coming up, shows that date\'s chart instead of going blank', async () => {
    const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
    // Any date strictly after today - real value doesn't matter, only
    // that it's in the future and there's nothing scheduled today.
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, future);

    const res = await request(app).get('/volunteers/monday');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /No upcoming floater assignments\./);
  });

  await t.test('a real request: floater cards only show a position once it has a confirmed (approved) floater - an unassigned/still-pending one is invisible to members, not shown as "Unassigned"', async () => {
    const { createPermanentJob, setAssignment } = require('../utils/substitutes');
    const list = await db.prepare("SELECT id FROM volunteer_lists WHERE day = 'monday'").get();
    // Closer than the earlier subtest's own future date, so
    // closestUpcomingDate actually lands on THIS date - not the older
    // one, which would leave this test's own assignments invisible.
    const date = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.prepare('INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)').run(list.id, date);

    const pendingJobId = await createPermanentJob({ day: 'monday', hourPosition: 1, title: 'Still Pending Job', room: 'Room P' });
    const approvedJobId = await createPermanentJob({ day: 'monday', hourPosition: 1, title: 'Confirmed Job', room: 'Room A' });
    const floater = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Kiosk Test Floater', 'kiosk-floater-1', 'parent')").run()).lastInsertRowid;

    // 'pending' the way the real auto-suggest system leaves a slot until an
    // admin approves it (utils/substitutes.js's own autoAssign - not
    // exported, so this mirrors its INSERT directly).
    await db.prepare(
      `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status) VALUES (?, 'job', ?, ?, 0, 'pending')`
    ).run(date, pendingJobId, floater);
    await setAssignment(date, 'job', approvedJobId, floater, false); // 'approved'

    const res = await request(app).get('/volunteers/monday');
    assert.equal(res.status, 200);
    // The approved job shows, with the floater's real name...
    assert.match(res.text, /Confirmed Job/);
    const confirmedRowMatch = res.text.match(/Confirmed Job[\s\S]*?<\/tr>/);
    assert.ok(confirmedRowMatch && /Kiosk Test Floater/.test(confirmedRowMatch[0]), 'approved assignment should show the floater\'s name');
    // ...but a real request: "do not show positions that don't have
    // someone assigned. if it is unassigned it's invisible to members.
    // only admins can see it" - the still-pending job must not appear on
    // the public kiosk at all, not even as "Unassigned".
    assert.doesNotMatch(res.text, /Still Pending Job/, 'an unassigned/still-pending position must be invisible on the public kiosk, not shown as "Unassigned"');
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

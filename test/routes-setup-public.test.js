// Real HTTP-level coverage for the public, no-login GET /setup/:day - a
// real request: "setup/cleanup team kiosk view. change it to where
// members only see their team list, leave off the assignments." Shows
// the standing Teams roster (who's on each team, no dates involved),
// same shape/markup as the admin manage page - not the date-scoped Task
// 1/Task 2 assignment cards this route briefly showed instead (that
// per-date task detail is exactly the "assignments" this member-facing
// page now leaves off; the admin Setup/Cleanup Assignments tab still has
// it, untouched).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-setup-public-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-setup-public-test-uploads-${process.pid}`);
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

test('GET /setup/:day', async (t) => {
  await t.test('an invalid day 404s', async () => {
    const res = await request(app).get('/setup/tuesday');
    assert.equal(res.status, 404);
  });

  await t.test('a day picker is offered at the bare /setup route, linking into both days', async () => {
    const res = await request(app).get('/setup');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/setup\/monday"/);
    assert.match(res.text, /href="\/setup\/wednesday"/);
  });

  await t.test('a day with no teams shows the muted "no teams" panel', async () => {
    const res = await request(app).get('/setup/monday');
    assert.equal(res.status, 200);
    assert.match(res.text, /No teams set up yet\./);
  });

  await t.test('a day with teams shows each team, its leader/description, and its members - no per-date assignment detail', async () => {
    const leader = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Leader', 'setup-public-pat', 'parent')").run();
    const team = await db
      .prepare(
        "INSERT INTO setup_teams (day, title, description, leader_id, meeting_time, meeting_location) VALUES ('monday', 'Kitchen Crew', 'Wipe down counters', ?, '9:00am', 'Front Lobby')"
      )
      .run(leader.lastInsertRowid);
    const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jane Smith', 'setup-public-jane', 'parent')").run();
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

    const res = await request(app).get('/setup/monday');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /No teams set up yet\./);
    assert.match(res.text, /Kitchen Crew/);
    assert.match(res.text, /Jane Smith/);

    // A real request: "the leader, time, location, all those details
    // should show on the kiosk side when you click the setup/cleanup
    // button" - this is the actual no-login kiosk route, so this is the
    // one place that request is truly verified end to end.
    assert.match(res.text, /Pat Leader/);
    assert.match(res.text, /9:00am/);
    assert.match(res.text, /Front Lobby/);

    // No per-date task pick detail - that's the "assignments" this page
    // now leaves off entirely.
    assert.doesNotMatch(res.text, /floater-assign-btn/);
    assert.doesNotMatch(res.text, /No suggestion/);
    assert.doesNotMatch(res.text, /class="floater-card-meta"/);
  });
});

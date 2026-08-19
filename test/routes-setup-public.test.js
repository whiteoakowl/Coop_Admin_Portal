// Real HTTP-level coverage for the public, no-login GET /setup/:day - a
// real user request: "After clicking the day button it will open to the
// member view of the assignment cards for the current day or the closest
// date coming up." Previously this route showed the standing Teams
// roster (who's on each team, no dates involved); it now shows the same
// date-scoped Task 1/Task 2 assignment cards the admin Setup/Cleanup
// Assignments tab shows, read-only (utils/setup.js's assignmentCardsForDate,
// shared with routes/admin-setup.js).
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

  await t.test('a day with no upcoming session dates shows the muted "no assignments" panel', async () => {
    const res = await request(app).get('/setup/monday');
    assert.equal(res.status, 200);
    assert.match(res.text, /No upcoming Setup\/Cleanup assignments\./);
  });

  await t.test('with a past date and a future date, shows the closest UPCOMING one - never a stale past date', async () => {
    const leader = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Pat Leader', 'setup-public-pat', 'parent')").run();
    const team = await db
      .prepare("INSERT INTO setup_teams (day, title, leader_id, meeting_time, meeting_location) VALUES ('monday', 'Kitchen Crew', ?, '9:00am', 'Front Lobby')")
      .run(leader.lastInsertRowid);
    const section = await db
      .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Kitchen Tasks', ?, 0)")
      .run(team.lastInsertRowid);
    await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Wipe down counters');
    const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jane Smith', 'setup-public-jane', 'parent')").run();
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

    await db.prepare("INSERT INTO setup_dates (day, session_date) VALUES ('monday', '2020-01-01')").run(); // long past
    await db.prepare("INSERT INTO setup_dates (day, session_date) VALUES ('monday', '2026-08-24')").run(); // upcoming

    const res = await request(app).get('/setup/monday');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /No upcoming Setup\/Cleanup assignments\./);
    assert.match(res.text, /Kitchen Crew/);
    assert.match(res.text, /Jane Smith/);
    // Read-only: no Assign/Unassign controls, just plain "No suggestion"
    // text for a member with nothing assigned yet for that date - the
    // same "reassigning happens on the live/admin tab, not here" rule
    // partials/setup-assignment-cards.ejs's editable flag already
    // enforces for the Archive view.
    assert.doesNotMatch(res.text, /floater-assign-btn/);
    assert.match(res.text, /No suggestion/);

    // A real request: "the leader, time, location, all those details
    // should show on the kiosk side when you click the setup/cleanup
    // button" - this is the actual no-login kiosk route, so this is the
    // one place that request is truly verified end to end.
    assert.match(res.text, /class="floater-card-meta"/);
    assert.match(res.text, /Pat Leader/);
    assert.match(res.text, /9:00am/);
    assert.match(res.text, /Front Lobby/);
  });
});

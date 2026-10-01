// Real HTTP-level coverage for a real request that reverses an earlier
// one: "setup/cleanup teams lists should not show red highlight for
// absences. All color highlights of member only happens on setup/
// cleanup assignment page." The admin Setup/Cleanup Teams manage page
// (routes/admin-setup.js), its print preview, and the public kiosk-facing
// Teams view (routes/setup.js) used to highlight an absent member's whole
// row red (utils/classSchedule.js's absentMemberIdsForDate) - none of
// them do anymore; that highlight now lives only on the Assignments page
// (views/partials/setup-assignment-cards.ejs, unchanged - see
// test/routes-setup-absent-highlight.test.js's own successor coverage
// there, or whichever suite currently covers that page's own absent/
// checked-in/checked-out highlighting).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-teams-no-absence-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-teams-no-absence-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { absentMemberIdsForDate } = require('../utils/classSchedule');

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

const today = todayISO();

// absentMemberIdsForDate itself is still a real, used utility (the
// Assignments page's own roster still highlights absent members with it -
// utils/setup.js's assignmentCardsForDate) - only the Teams-side call
// sites were removed, not the function.
test('utils/classSchedule.js absentMemberIdsForDate still exists and works - only its Teams-page call sites were removed', async () => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: absentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Absent Person', 'unit-test-absent', 'parent')")
    .run();
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-01-05', 'absent', 'admin')").run(absentId, rosterId);

  const ids = await absentMemberIdsForDate('2026-01-05');
  assert.ok(ids.has(absentId));
});

test('Setup/Cleanup Teams: admin manage page, print preview, and kiosk public view never highlight an absent member\'s row, even when they are absent today', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: absentMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Absent Volunteer', '000301', '000301', 'parent')")
    .run();
  await db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')`
  ).run(absentMemberId, rosterId, today);

  for (const day of ['monday', 'wednesday']) {
    const { lastInsertRowid: teamId } = await db.prepare(`INSERT INTO setup_teams (day, title) VALUES ('${day}', 'Chairs & Tables')`).run();
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, absentMemberId);

    await t.test(`admin manage page for ${day}`, async () => {
      const res = await request(app).get(`/admin/setup/${day}/manage`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.match(res.text, /Absent Volunteer/, 'sanity check: the member should actually be on the page');
      assert.doesNotMatch(res.text, /team-member-row-absent/, 'no absence highlighting should ever appear on the Teams manage page');
      assert.doesNotMatch(res.text, /absent today/);
    });

    await t.test(`print preview for ${day}`, async () => {
      const res = await request(app).get(`/admin/setup/${day}/teams/print`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      assert.match(res.text, /Absent Volunteer/, 'sanity check: the member should actually be on the page');
      assert.doesNotMatch(res.text, /team-member-row-absent/, 'no absence highlighting should ever appear on the Teams print preview');
      assert.doesNotMatch(res.text, /absent today/);
    });

    await t.test(`kiosk public view for ${day}`, async () => {
      const res = await request(app).get(`/setup/${day}`);
      assert.equal(res.status, 200);
      assert.match(res.text, /Absent Volunteer/, 'sanity check: the member should actually be on the page');
      assert.doesNotMatch(res.text, /team-member-row-absent/, 'no absence highlighting should ever appear on the public kiosk Teams view');
      assert.doesNotMatch(res.text, /absent today/);
    });
  }
});

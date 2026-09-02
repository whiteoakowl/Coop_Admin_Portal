// Real HTTP-level coverage for a feature this session: both the admin
// Setup/Cleanup Teams manage page (routes/admin-setup.js) and its public
// kiosk-facing view (routes/setup.js) highlight a team member's whole row
// red when they're marked absent that day (utils/classSchedule.js's
// absentMemberIdsForDate, the same attendance-status source the Class
// Schedule grid's own absent-student count already uses).
//
// The two pages now resolve WHICH date to check absence against
// identically - both use utils/days.js's defaultDateFor, which returns
// today's own date only when today's real weekday matches the tab being
// viewed (Setup/Cleanup teams are a standing weekly roster with no date
// picker of their own, unlike the Class Schedule grid). A real request:
// "setup/cleanup team kiosk view. change it to where members only see
// their team list, leave off the assignments" moved the kiosk page
// (routes/setup.js) back to the plain standing Teams roster - it used to
// show date-scoped assignment cards instead (utils/setup.js's
// assignmentCardsForDate), resolving its date completely differently
// (closest UPCOMING setup_dates entry, unrelated to today's weekday),
// which is why this suite's own assertions below are still computed
// relative to the real weekday at run time rather than hardcoding an
// assumption about which day today is (the exact flakiness this session
// already had to fix once, in the Logs day-toggle tests - see that
// suite's own comment) - it gives real coverage on every day of the
// week, not just Mondays/Wednesdays, and doesn't need to special-case
// the kiosk page's date resolution anymore now that it matches the
// admin page's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-absent-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-absent-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, weekdayOf } = require('../utils/dates');
const { defaultDateFor } = require('../utils/days');
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

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };
const today = todayISO();

test('utils/days.js defaultDateFor only returns today for the day of the week that actually is today', () => {
  for (const day of ['monday', 'wednesday']) {
    const expected = weekdayOf(today) === DAY_WEEKDAY[day] ? today : '';
    assert.equal(defaultDateFor(day), expected, `defaultDateFor('${day}') should be ${JSON.stringify(expected)} today`);
  }
});

test('utils/classSchedule.js absentMemberIdsForDate', async (t) => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: absentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Absent Person', 'unit-test-absent', 'parent')")
    .run();
  const { lastInsertRowid: presentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Present Person', 'unit-test-present', 'parent')")
    .run();
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-01-05', 'absent', 'admin')").run(absentId, rosterId);
  await db.prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-01-05', 'present', 'admin')").run(presentId, rosterId);

  await t.test('returns only members marked absent on that exact date', async () => {
    const ids = await absentMemberIdsForDate('2026-01-05');
    assert.ok(ids.has(absentId));
    assert.ok(!ids.has(presentId));
  });

  await t.test('returns nothing for a date with no attendance records at all', async () => {
    assert.equal((await absentMemberIdsForDate('2026-01-06')).size, 0);
  });

  await t.test('an empty/falsy date returns an empty set rather than matching everything', async () => {
    assert.equal((await absentMemberIdsForDate('')).size, 0);
    assert.equal((await absentMemberIdsForDate(null)).size, 0);
  });
});

test('Setup/Cleanup: admin + kiosk views highlight an absent member\'s whole row red, only on today\'s own day', async (t) => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: absentMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Absent Volunteer', '000301', '000301', 'parent')")
    .run();
  const { lastInsertRowid: presentMemberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Present Volunteer', '000302', '000302', 'parent')")
    .run();
  // Absent *today* - whether that ends up mattering to either tab depends
  // on whether today is actually Monday or Wednesday, checked per-day below.
  await db.prepare(
    `INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, ?, 'absent', 'admin')`
  ).run(absentMemberId, rosterId, today);

  for (const day of ['monday', 'wednesday']) {
    const { lastInsertRowid: teamId } = await db.prepare(`INSERT INTO setup_teams (day, title) VALUES ('${day}', 'Chairs & Tables')`).run();
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?), (?, ?)').run(teamId, absentMemberId, teamId, presentMemberId);

    const isToday = weekdayOf(today) === DAY_WEEKDAY[day];

    await t.test(`admin manage page for ${day} (${isToday ? 'is' : 'is not'} today)`, async () => {
      const res = await request(app).get(`/admin/setup/${day}/manage`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      if (isToday) {
        assert.match(res.text, /team-member-row team-member-row-absent"[^>]*>\s*<span class="team-member-avatar">A<\/span>/, 'the absent member should be highlighted');
      } else {
        assert.doesNotMatch(res.text, /team-member-row-absent/, "today doesn't fall on this day, so nothing should be highlighted");
      }
      // The present member is never highlighted either way.
      assert.doesNotMatch(res.text, /team-member-row-absent">\s*<span class="team-member-avatar">P<\/span>/);
    });

    // The kiosk-facing public view (routes/setup.js) is the same standing
    // Teams roster the admin manage page renders (views/setup-public.ejs
    // shares admin-setup.ejs's own team-member-row/team-member-avatar
    // markup and absence-date resolution) - a real request: "setup/
    // cleanup team kiosk view... leave off the assignments" moved it back
    // off the date-scoped assignment cards it briefly showed instead, so
    // this now asserts the identical markup/highlight the admin page's
    // own subtest above just checked.
    await t.test(`kiosk public view for ${day} (${isToday ? 'is' : 'is not'} today)`, async () => {
      const res = await request(app).get(`/setup/${day}`);
      assert.equal(res.status, 200);
      if (isToday) {
        assert.match(res.text, /team-member-row team-member-row-absent"[^>]*>\s*<span class="team-member-avatar">A<\/span>/, 'the absent member should be highlighted');
      } else {
        assert.doesNotMatch(res.text, /team-member-row-absent/, "today doesn't fall on this day, so nothing should be highlighted");
      }
      // The present member is never highlighted either way.
      assert.doesNotMatch(res.text, /team-member-row-absent">\s*<span class="team-member-avatar">P<\/span>/);
    });
  }
});

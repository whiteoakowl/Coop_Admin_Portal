// Real HTTP-level coverage for the Setup/Cleanup Assignments roster's
// checked-in highlight (partials/setup-assignment-cards.ejs) - class
// name/precedence only, not color (that's CSS - see styles.css's own
// comment on the real bug report: it used to share the absent row's red
// styling, so a member who'd actually shown up got flagged the same as
// one who never came; now it's green). Admin Assignments tab only - a
// real request: "setup/cleanup team kiosk view. change it to where
// members only see their team list, leave off the assignments" moved
// /setup/:day (routes/setup.js) back to the plain standing Teams roster,
// which never had a checked-in highlight of its own (only the absent one
// - see test/routes-setup-absent-highlight.test.js). Mirrors that other
// suite's own admin-side setup almost exactly - same setup_dates/
// assignmentCardsForDate machinery, same partial - just keyed off an
// actual kiosk check-in (attendance.check_in_time) instead of an absence
// mark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-checked-in-highlight-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-checked-in-highlight-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { checkedInMemberIdsForDate } = require('../utils/classSchedule');

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

test('utils/classSchedule.js checkedInMemberIdsForDate', async () => {
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Unit Test Roster', 'Class Schedule')").run();
  const { lastInsertRowid: checkedInId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Checked In Person', 'unit-test-ci', 'parent')")
    .run();
  const { lastInsertRowid: notCheckedInId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Some Not Checked In Person', 'unit-test-nci', 'parent')")
    .run();
  await db
    .prepare(
      "INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, '2026-01-05', 'present', 'kiosk', 1736100000000)"
    )
    .run(checkedInId, rosterId);
  // Marked present but never actually checked in (e.g. an admin manual
  // override with no kiosk scan) - should NOT count as checked in.
  await db
    .prepare("INSERT INTO attendance (member_id, roster_id, session_date, status, source) VALUES (?, ?, '2026-01-05', 'present', 'admin')")
    .run(notCheckedInId, rosterId);

  const ids = await checkedInMemberIdsForDate('2026-01-05');
  assert.ok(ids.has(checkedInId));
  assert.ok(!ids.has(notCheckedInId));
  assert.equal((await checkedInMemberIdsForDate('2026-01-06')).size, 0, 'a date with no attendance records returns nothing');
  assert.equal((await checkedInMemberIdsForDate('')).size, 0, 'an empty date returns an empty set rather than matching everything');
});

test('Setup/Cleanup Assignments: admin + kiosk views highlight a checked-in member\'s whole row (green - see styles.css)', async (t) => {
  const cookie = await loginAsAdmin();

  for (const day of ['monday', 'wednesday']) {
    const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Test Roster', 'Class Schedule')").run();
    const { lastInsertRowid: checkedInMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Checked In Volunteer', ?, ?, 'parent')")
      .run(`ci-${day}`, `ci-${day}`);
    const { lastInsertRowid: notCheckedInMemberId } = await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Not Checked In Volunteer', ?, ?, 'parent')")
      .run(`nci-${day}`, `nci-${day}`);

    await db
      .prepare(
        `INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, ?, 'present', 'kiosk', 1736100000000)`
      )
      .run(checkedInMemberId, rosterId, today);

    const { lastInsertRowid: teamId } = await db.prepare(`INSERT INTO setup_teams (day, title) VALUES ('${day}', 'Chairs & Tables')`).run();
    await db
      .prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?), (?, ?)')
      .run(teamId, checkedInMemberId, teamId, notCheckedInMemberId);

    // assignmentCardsForDate defaults to the closest upcoming setup_dates
    // entry - give this day's team a session today so both pages resolve
    // to `today` and actually exercise the highlight, same as the absent-
    // highlight suite's own setup.
    await db.prepare('INSERT INTO setup_dates (day, session_date) VALUES (?, ?)').run(day, today);

    await t.test(`admin Assignments tab for ${day}`, async () => {
      const res = await request(app).get(`/admin/setup/${day}/assignments`).set('Cookie', cookie);
      assert.equal(res.status, 200);
      // The member name itself is a clickable link (a later, real
      // request: "make member names clickable -> profile across every
      // list surface"), not plain text directly in the <td>.
      assert.match(
        res.text,
        /<tr class="setup-assignment-row-checked-in">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Checked In Volunteer/,
        'the checked-in member should be highlighted'
      );
      assert.doesNotMatch(
        res.text,
        /<tr class="setup-assignment-row-checked-in">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Not Checked In Volunteer/,
        'a member who never checked in is never highlighted'
      );
    });
  }
});

test('Setup/Cleanup Assignments: an absent member is highlighted absent, not checked-in, even if somehow both are true', async () => {
  const cookie = await loginAsAdmin();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category) VALUES ('Precedence Roster', 'Class Schedule')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_code, member_type) VALUES ('Both Flags Volunteer', 'both-flags', 'both-flags', 'parent')")
    .run();
  // A corrected status after an earlier check-in: still has a check-in
  // timestamp on record, but the row's current status is 'absent'.
  await db
    .prepare(
      `INSERT INTO attendance (member_id, roster_id, session_date, status, source, check_in_time) VALUES (?, ?, ?, 'absent', 'admin', 1736100000000)`
    )
    .run(memberId, rosterId, today);

  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Precedence Team')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);
  // The previous test already gave monday a setup_dates row for today -
  // reuse it (a second row for the same day/date would collide).

  const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  assert.equal(res.status, 200);
  // Scoped to this specific member's own row, not "anywhere on the page" -
  // an earlier test in this same file left an unrelated, genuinely
  // checked-in member on this same monday tab, so the page as a whole
  // legitimately does contain setup-assignment-row-checked-in elsewhere.
  assert.match(
    res.text,
    /<tr class="setup-assignment-row-absent">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Both Flags Volunteer/,
    'absent takes precedence over checked-in when both are true'
  );
  assert.doesNotMatch(
    res.text,
    /<tr class="setup-assignment-row-checked-in">\s*<td class="floater-card-position">\s*<a class="member-name-link"[^>]*>Both Flags Volunteer/
  );
});

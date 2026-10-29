// A real bug report: "Spring 2027 - Monday, Spring 2026 Wednesday are
// showing rosters and attendance from fall days. It should be its own."
// ensureDayRoster used to key a day's Parent/Student roster by day+role
// alone (an app_settings row like 'monday_parent_roster_id') with no
// semester component at all, so every semester sharing that day shared
// the one same roster row, roster_dates, and attendance history. This
// covers the fix: two different semesters on the same day now get two
// distinct roster rows (and the dates/attendance on one never show up
// under the other), plus the "first-touch legacy claim" migration path
// that lets a pre-existing, semester-less day roster keep its history
// instead of becoming orphaned once the new semester-scoped keying
// takes effect (see utils/classSchedule.js's own comment on
// ensureDayRoster and migrations/20261220010000_rosters_semester_id.sql).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `ensureDayRoster-semester-test-db-${process.pid}.db`);
process.env.DB_PATH = testDbPath;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const app = require('../server');
const db = require('../db');
const { ensureDayRoster } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
});

async function makeSemester(title) {
  return (await db.prepare('INSERT INTO semesters (title) VALUES (?) RETURNING id').get(title)).id;
}

test('ensureDayRoster gives two different semesters on the same day their own separate roster', async () => {
  const fall = await makeSemester('Fall Ensure Test');
  const spring = await makeSemester('Spring Ensure Test');

  const fallRosterId = await ensureDayRoster('monday', 'parent', fall);
  const springRosterId = await ensureDayRoster('monday', 'parent', spring);
  assert.notEqual(fallRosterId, springRosterId);

  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(fallRosterId, '2026-09-14');

  const fallDates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(fallRosterId);
  const springDates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(springRosterId);
  assert.deepEqual(fallDates.map((d) => d.session_date), ['2026-09-14']);
  assert.deepEqual(springDates, []);

  // Calling it again for the same semester returns the same roster, not a new one.
  assert.equal(await ensureDayRoster('monday', 'parent', fall), fallRosterId);
  assert.equal(await ensureDayRoster('monday', 'parent', spring), springRosterId);

  const fallRoster = await db.prepare('SELECT semester_id FROM rosters WHERE id = ?').get(fallRosterId);
  const springRoster = await db.prepare('SELECT semester_id FROM rosters WHERE id = ?').get(springRosterId);
  assert.equal(fallRoster.semester_id, fall);
  assert.equal(springRoster.semester_id, spring);
});

test('ensureDayRoster: the first semester to resolve a pre-existing legacy (semester-less) day roster claims it, keeping its history; every other semester gets a genuinely new one', async () => {
  // Server boot (server.js) already seeds a semester-less day roster for
  // every active day under the OLD key - exactly the real-world shape
  // this legacy-claim path exists for. Use that already-seeded Wednesday
  // Student roster as the "legacy" one and give it real history.
  const legacyRosterId = await ensureDayRoster('wednesday', 'student', null);
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(legacyRosterId, '2025-10-08');
  const legacyKeyBefore = await db.prepare("SELECT value FROM app_settings WHERE key = 'wednesday_student_roster_id'").get();
  assert.equal(legacyKeyBefore.value, String(legacyRosterId));

  const fall = await makeSemester('Fall Legacy Claim Test');
  const spring = await makeSemester('Spring Legacy Claim Test');

  // Fall is the first semester to ever resolve this day+role post-fix -
  // it claims the legacy roster outright (same id, now tagged with its
  // semester_id), keeping the pre-existing date on it visible.
  const fallRosterId = await ensureDayRoster('wednesday', 'student', fall);
  assert.equal(fallRosterId, legacyRosterId);
  const claimed = await db.prepare('SELECT semester_id FROM rosters WHERE id = ?').get(fallRosterId);
  assert.equal(claimed.semester_id, fall);
  const fallDates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(fallRosterId);
  assert.deepEqual(fallDates.map((d) => d.session_date), ['2025-10-08']);

  // The legacy key is now gone, so a different semester asking for the
  // same day+role afterward gets a brand-new, empty roster of its own -
  // never the one Fall just claimed.
  const legacyKeyRow = await db.prepare("SELECT value FROM app_settings WHERE key = 'wednesday_student_roster_id'").get();
  assert.equal(legacyKeyRow, undefined);

  const springRosterId = await ensureDayRoster('wednesday', 'student', spring);
  assert.notEqual(springRosterId, fallRosterId);
  const springDates = await db.prepare('SELECT session_date FROM roster_dates WHERE roster_id = ?').all(springRosterId);
  assert.deepEqual(springDates, []);
});

test('ensureDayRoster(day, role) with no semesterId falls back to the active Kiosk semester, same convention resolveSemesterId callers use everywhere else', async () => {
  const { setActiveKioskSemesterId } = require('../utils/kioskSettings');
  const active = await makeSemester('Active Kiosk Default Test');
  await setActiveKioskSemesterId(active);

  const viaDefault = await ensureDayRoster('tuesday', 'parent');
  const viaExplicit = await ensureDayRoster('tuesday', 'parent', active);
  assert.equal(viaDefault, viaExplicit);
});

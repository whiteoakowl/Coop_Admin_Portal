// A real bug report: "absence log should only show the original
// submission of absence from the absence form. it doesn't need to show
// absence log from classes. absences from the absence form do still
// appear on each class roster." routes/absence.js writes one
// absence_submissions row per roster a member belongs to that day (the
// day-level Parent/Student roster AND every one of that member's own
// class rosters - see utils/rosters.js's getMemberRostersForDate), so a
// member on several class rosters the same day used to show up in the
// standalone admin Log tab once per roster instead of once per actual
// submission. Fixed by scoping the Log tab's own query to the day-level
// roster only (category != 'Class Roster') - see routes/admin-logs.js's
// allAbsenceSubmissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `absence-log-no-per-class-dup-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `absence-log-no-per-class-dup-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');

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

test('one absence form submission across a day roster + 2 class rosters shows up once in the Log tab, but stays on every class roster', async (t) => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Multi Class Absence Member', 'multi-class-absence-member', 'parent')")
    .run();
  const today = todayISO();

  const dayRoster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  const { lastInsertRowid: classRosterAId } = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Absence Dup Class A', 'Class Roster', 'monday')")
    .run();
  const { lastInsertRowid: classRosterBId } = await db
    .prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Absence Dup Class B', 'Class Roster', 'monday')")
    .run();

  for (const rosterId of [dayRoster.id, classRosterAId, classRosterBId]) {
    await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(rosterId, today);
    await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(rosterId, memberId);
  }

  const submitRes = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({
      type: 'absence',
      parentId: String(memberId),
      studentIds: String(memberId),
      sessionDate: today,
      reasonCategory: 'personal',
      reason: 'multi-class dedup test',
    });
  assert.equal(submitRes.status, 200);

  await t.test('the underlying data still fans out to all 3 rosters (day + both classes)', async () => {
    const rows = await db.prepare('SELECT roster_id FROM absence_submissions WHERE member_id = ? AND session_date = ?').all(memberId, today);
    assert.equal(rows.length, 3, 'one absence_submissions row per roster the member belongs to');

    for (const rosterId of [dayRoster.id, classRosterAId, classRosterBId]) {
      const attendance = await db.prepare('SELECT status FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, rosterId, today);
      assert.equal(attendance.status, 'absent', `roster ${rosterId} should still show the absence on its own attendance row`);
    }
  });

  await t.test('the standalone Absence Log tab lists it exactly once, not once per class', async () => {
    const cookie = await loginAsAdmin();
    const res = await request(app).get('/admin/logs?tab=absence').set('Cookie', cookie);
    assert.equal(res.status, 200);
    // Both the on-screen table and its always-full print counterpart are
    // in the same document at once (see .logs-screen-table/.logs-print-
    // table in styles.css) - scope the occurrence count to just the
    // screen table's own <tbody>, or it would always double-count.
    const screenTableMatch = /<table class="roster-table members-table condensed-table logs-screen-table">[\s\S]*?<\/table>/.exec(res.text);
    assert.ok(screenTableMatch, 'expected to find the screen table');
    const screenTableHtml = screenTableMatch[0];
    const occurrences = (screenTableHtml.match(/Multi Class Absence Member/g) || []).length;
    assert.equal(occurrences, 1, 'the member should appear exactly once in the Absence Log, not once per roster');
    assert.match(screenTableHtml, /Monday Parents/, 'the one row shown should be attributed to the day-level roster');
    assert.doesNotMatch(screenTableHtml, /Absence Dup Class/, 'no per-class roster row should appear in the standalone Log tab');
  });
});

// A real request: "Absence/late log, include the date and time the
// member submitted the form on the log. Use 12/12/2026 and 12:45pm as the
// format." absence_submissions already carried submitted_at (its own
// migration's default now_text()) - this was simply never read or shown
// anywhere. utils/dates.js's new formatNumericDateAndTime gives the exact
// "12/12/2026" + "12:45pm" shape (numeric date, lowercase/no-space am/pm)
// neither existing formatDateAndTime (space + uppercase AM/PM) nor
// formatFriendlyDateAndTime (spelled-out month) produces on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `absence-log-submitted-timestamp-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `absence-log-submitted-timestamp-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO } = require('../utils/dates');
const { formatNumericDateAndTime } = require('../utils/dates');

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

test('formatNumericDateAndTime: "12/12/2026" + "12:45pm" shape - numeric date, lowercase no-space am/pm', () => {
  // 2026-12-12 17:45:00 UTC = 12:45pm Eastern (EST, UTC-5, December).
  const { dateLabel, timeLabel } = formatNumericDateAndTime('2026-12-12 17:45:00');
  assert.equal(dateLabel, '12/12/2026');
  assert.equal(timeLabel, '12:45pm');
});

test('formatNumericDateAndTime: a null/empty timestamp returns null labels rather than throwing', () => {
  assert.deepEqual(formatNumericDateAndTime(null), { dateLabel: null, timeLabel: null });
  assert.deepEqual(formatNumericDateAndTime(''), { dateLabel: null, timeLabel: null });
});

test('Absence/Late Log shows the real form-submission date/time, not the session date the absence is for', async () => {
  const cookie = await loginAsAdmin();
  const today = todayISO();

  const { lastInsertRowid: parentId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Submitted Timestamp Parent', 'submitted-ts-parent', 'parent')")
    .run();
  const { lastInsertRowid: rosterId } = await db.prepare("INSERT INTO rosters (name, category, schedule_day) VALUES ('Submitted TS Roster', 'Parent', 'monday')").run();
  await db.prepare('INSERT INTO roster_members (roster_id, member_id) VALUES (?, ?)').run(rosterId, parentId);
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?)').run(rosterId, today);

  const submitRes = await request(app)
    .post('/absence/submit')
    .type('form')
    .send({ type: 'absence', parentId: String(parentId), studentIds: [String(parentId)], sessionDate: today, reasonCategory: 'personal', reason: 'Testing submitted timestamp' });
  assert.equal(submitRes.status, 200);

  // Real submitted_at was just set by now_text() to right now - confirm
  // the Logs page renders the exact same date/time formatNumericDateAndTime
  // would produce for that real row, not the session date the absence is
  // actually for (which could easily be a different, even past or future,
  // date from the real moment the form was filled out).
  const row = await db.prepare('SELECT submitted_at AS "submittedAt" FROM absence_submissions WHERE member_id = ?').get(parentId);
  assert.ok(row && row.submittedAt, 'expected a real absence_submissions row with submitted_at set');
  const expected = formatNumericDateAndTime(row.submittedAt);

  const logRes = await request(app).get('/admin/logs?tab=absence').set('Cookie', cookie);
  assert.equal(logRes.status, 200);
  assert.match(logRes.text, new RegExp(`Submitted ${expected.dateLabel.replace(/\//g, '\\/')} ${expected.timeLabel}`), 'expected the mobile accordion view to show the real submitted date/time');
  assert.match(logRes.text, new RegExp(`<td>${expected.dateLabel.replace(/\//g, '\\/')} ${expected.timeLabel}</td>`), 'expected the print table to show the real submitted date/time');

  const csvRes = await request(app).get('/admin/logs/absence/export.csv').set('Cookie', cookie);
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.text, /"Submitted Date","Submitted Time"/, 'expected CSV headers for the submitted date/time');
  assert.match(
    csvRes.text,
    new RegExp(`"${expected.dateLabel.replace(/\//g, '\\/')}","${expected.timeLabel}"`),
    'expected the CSV row to carry the real submitted date/time'
  );
});

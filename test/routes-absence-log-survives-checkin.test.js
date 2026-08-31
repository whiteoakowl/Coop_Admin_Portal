// Real HTTP-level coverage for a real bug report: "If someone submits an
// absence/late form, it will be over ridden and show a green P for
// present if they then come in later and check in, it will also show
// their check in and out time and cleaning team if they did that as
// well. The log will still record their absence/late form."
//
// The first half (real check-in overrides a prior absent/late status to
// present, with real times) already worked and is covered by
// test/routes-kiosk-checkin.test.js. This file covers the second half,
// which didn't: routes/admin-logs.js's Absence/Late tab used to read
// straight off the live attendance row a submission first wrote, so the
// very same check-in that (correctly) flips that row to
// status='present'/source='kiosk' also (incorrectly) made the original
// submission vanish from the log. Fixed by giving each submission its
// own append-only row (absence_submissions - see that migration's own
// comment) that a later check-in never touches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `routes-absence-log-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `routes-absence-log-test-uploads-${process.pid}`);
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

test('an absence/late submission stays in the Logs tab after a later real check-in overrides it to present', async (t) => {
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Absence Then Checkin Parent', 'Absence Then Checkin Parent', 'parent')")
    .run();
  const roster = await db.prepare("SELECT id FROM rosters WHERE name = 'Monday Parents'").get();
  const today = todayISO();
  await db.prepare('INSERT INTO roster_dates (roster_id, session_date) VALUES (?, ?) ON CONFLICT (roster_id, session_date) DO NOTHING').run(roster.id, today);
  await db.prepare("INSERT INTO roster_members (roster_id, member_id, source) VALUES (?, ?, 'manual') ON CONFLICT (roster_id, member_id) DO NOTHING").run(roster.id, memberId);

  await t.test('submitting the absence form marks the member absent', async () => {
    const res = await request(app)
      .post('/absence/submit')
      .type('form')
      .send({
        type: 'absence',
        parentId: String(memberId),
        studentIds: String(memberId),
        sessionDate: today,
        reasonCategory: 'personal',
        reason: 'family trip',
      });
    assert.equal(res.status, 200);
    const attendance = await db.prepare('SELECT status, source FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, roster.id, today);
    assert.equal(attendance.status, 'absent');
    assert.equal(attendance.source, 'absence_form');
  });

  const adminCookie = await loginAsAdmin();

  await t.test('the Logs Absence tab shows the submission right after it happens', async () => {
    const res = await request(app).get('/admin/logs?tab=absence').set('Cookie', adminCookie);
    assert.match(res.text, /Absence Then Checkin Parent/);
    assert.match(res.text, /family trip/);
  });

  await t.test('a real kiosk check-in overrides the attendance row to present', async () => {
    const res = await request(app).post('/kiosk/checkin/scan').type('form').send({ barcode: 'Absence Then Checkin Parent' });
    assert.equal(res.body.ok, true);
    const attendance = await db.prepare('SELECT status, source, check_in_time FROM attendance WHERE member_id = ? AND roster_id = ? AND session_date = ?').get(memberId, roster.id, today);
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.source, 'kiosk');
    assert.ok(attendance.check_in_time, 'a real check_in_time should now be recorded');
  });

  await t.test('the Logs Absence tab STILL shows the original submission after the override', async () => {
    const res = await request(app).get('/admin/logs?tab=absence').set('Cookie', adminCookie);
    assert.match(res.text, /Absence Then Checkin Parent/);
    assert.match(res.text, /family trip/);
  });

  await t.test('the live Attendance grid now shows the member as present with a real check-in time, not absent', async () => {
    const res = await request(app).get('/admin/rosters?tab=monday-parent').set('Cookie', adminCookie);
    assert.equal(res.status, 200);
    const presentSelectRe = new RegExp(`roster-cell-select-present"[^>]*data-member="${memberId}"`);
    assert.match(res.text, presentSelectRe, "the member's own select should now show status present, not absent");
  });
});

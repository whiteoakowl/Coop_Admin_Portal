// Coverage for two live bug reports, both traced to the same root design
// flaw: "Schedule Cards" (in every one of its display surfaces - the
// member profile's Schedule popup, admin Schedules > Student/Parent
// tabs, both print pages, and the visual Schedule Card under Members >
// Cards) kept showing a stale or truncated time even after the
// underlying Class Schedule data and its derivation logic were both
// confirmed correct.
//
// Cause #1: getMemberSchedule/scheduleList (utils/schedule.js) used to
// read from member_schedules, a cache that only rebuilds when something
// explicitly triggers syncMemberSchedulesForDay. A member whose classes
// hadn't been touched since a fix to the time-derivation logic landed
// kept showing whatever was cached under the old logic - "did was it
// pushed AND did someone click Resync" is exactly the kind of two-step
// dependency that's easy to miss. Fixed by computing live instead (see
// liveMemberScheduleRowsForDay in utils/classSchedule.js) - this file's
// first test verifies a class set up with NO explicit sync call in
// between still shows correctly immediately.
//
// Cause #2 (an entirely separate, client-side bug found while chasing
// #1): the visual/printed Schedule Card's own table renderer
// (public/js/name-tag-render-core.js) had a startTimeOnly() helper that
// deliberately stripped everything after a class's start time before
// ever reaching the page - so even with cause #1 fixed, this specific
// surface would still have shown "9:00 AM" instead of "9:00 AM - 9:45
// AM". Removed entirely; this file's second test renders through the
// exact same NameTagRenderCore.renderBadgeElements path a real Schedule
// Card print/preview uses and checks the full range appears in the
// output HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `schedule-live-computation-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `schedule-live-computation-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');
const { getMemberSchedule } = require('../utils/schedule');
const { scheduleCardDataForMember, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  return { cookie: loginRes.headers['set-cookie'] };
}

async function setHours(cookie, day, startTimes, endTimes) {
  const page = await request(app).get(`/admin/schedule?tab=${day}`).set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  await request(app)
    .post(`/admin/class-schedule/${day}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ labels: ['Hour 1', 'Hour 2', 'Hour 3', 'Hour 4'], startTimes, endTimes, _csrf: csrfToken });
}

test('getMemberSchedule reflects a brand-new class immediately, with no separate resync call', async () => {
  const { cookie } = await loginAsAdmin();
  await setHours(cookie, 'monday', ['9:00 AM', '', '', ''], ['9:45 AM', '', '', '']);

  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Live Compute Kid', 'live-compute-kid', 'student')").run()).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Live Compute Class', room: 'Room Z' });
  // Deliberately no syncMemberSchedulesForDay/Resync call here - setEnrollment
  // itself doesn't call it (see setEnrollment's own comment), simulating
  // the exact live-bug-report scenario.
  await setEnrollment(classId, [studentId]);

  const { monday } = await getMemberSchedule(studentId);
  assert.equal(monday[0].time, '9:00 AM - 9:45 AM', 'the full time range should show immediately, with no cache to go stale');
  assert.equal(monday[0].class_name, 'Live Compute Class');
  assert.equal(monday[0].room, 'Room Z');
});

test('the visual Schedule Card (NameTagRenderCore.renderBadgeElements, the exact path Members > Cards and both print routes use) shows the full time range, not just the start time', async () => {
  const { cookie } = await loginAsAdmin();
  await setHours(cookie, 'monday', ['9:00 AM', '', '', ''], ['9:45 AM', '', '', '']);

  const studentId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Visual Range Kid', 'visual-range-kid', 'student')").run()).lastInsertRowid;
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Visual Range Class' });
  await setEnrollment(classId, [studentId]);

  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(studentId);
  const data = await scheduleCardDataForMember(member);
  assert.equal(data.mondaySchedule[0].time, '9:00 AM - 9:45 AM');

  const template = await getScheduleCardTemplate();
  const html = NameTagRenderCore.renderBadgeElements(template.elements, data);
  assert.match(html, /9:00 AM - 9:45 AM/, 'the rendered card HTML must include the full range, not a start-time-only truncation');
});

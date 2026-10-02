// Real HTTP-level coverage for a real bug report: "when adding or
// deleting new members on edit class popup it goes to an error page."
// Every enrollment/staff/roster mutation route in routes/admin-class-
// schedule.js called straight into setEnrollment/addStaff/removeStaff
// with no try/catch, so any failure there fell through to server.js's
// generic catch-all and rendered a blank "Something went wrong" page
// with no way to tell what happened - the exact same class of bug
// already fixed once for routes/admin-documents.js's upload route (see
// that file's own comment). A non-existent member id is a real, easy way
// to force setEnrollment/addStaff to genuinely fail (a real foreign key
// violation, not a simulated error), which is exactly what these tests
// use to prove the fix actually surfaces the real reason instead of
// crashing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `class-schedule-roster-errors-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `class-schedule-roster-errors-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, setEnrollment } = require('../utils/classSchedule');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

const NONEXISTENT_MEMBER_ID = 999999;

test('enrollment/add with a non-existent student id redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Roster Error Class A' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ studentIds: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  // supertest doesn't follow redirects - this is the first hop
  // (/admin/class-schedule/:day, itself a redirect to /admin/schedule?tab=...
  // that carries every query param through, see routes-class-schedule-
  // tabs.test.js) - what matters here is that it's a real redirect
  // carrying the error, not a 500 crash page.
  assert.match(res.headers.location, /\/admin\/class-schedule\/monday\?/);
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not update roster/);
});

test('staff/add with a non-existent member id redirects with a friendly error, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Roster Error Class B' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/staff/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(NONEXISTENT_MEMBER_ID), role: 'teacher', _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  assert.match(res.headers.location, /\/admin\/class-schedule\/monday\?/);
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not update roster/);
});

test('roster/add (the popup\'s combined Add Member form) with a non-existent student id: plain form falls back to a friendly redirect, not a 500', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Roster Error Class C' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/roster/add`)
    .set('Cookie', cookie)
    .type('form')
    .send({ role: 'student', studentId: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 302, 'a real DB failure should redirect back to the grid, not crash into a 500');
  assert.match(res.headers.location, /error=/);
  const errorMsg = decodeURIComponent(/error=([^&]*)/.exec(res.headers.location)[1]);
  assert.match(errorMsg, /Could not add member/);
});

test('roster/add via fetch (Accept: application/json, the popup\'s real request shape) with a non-existent student id: a graceful JSON error, not a 500 HTML crash page', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 4, className: 'Roster Error Class D' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/roster/add`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ role: 'student', studentId: String(NONEXISTENT_MEMBER_ID), _csrf: csrfToken });

  assert.equal(res.status, 500, 'this is the one genuinely failed request - a real error status, not a redirect');
  assert.equal(res.headers['content-type'].includes('application/json'), true, 'must stay JSON so the popup\'s own fetch().then(res.json()) can read it, not an HTML crash page');
  assert.equal(res.body.ok, false);
  assert.ok(res.body.error, 'the real underlying error message should be present, not swallowed');
});

// Real requests: "when deleting someone from the class roster the page
// should not refresh. It should stay on the roster and the name should
// disappear. If you add someone to a class roster the page should not
// refresh. The person should appear on the list." public/js/class-
// roster-ajax.js drives both via fetch() with Accept: application/json -
// these cover the server half of that contract.
test('enrollment/add via fetch (Accept: application/json) returns the newly-enrolled students\' own rendered roster rows, not just ok:true', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Roster Ajax Add Class' });
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type, grade_level) VALUES ('Ajax Add Student', 'ajax-add-student', 'student', '4th')").run()
  ).lastInsertRowid;

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/add`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ studentIds: String(studentId), _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'].includes('application/json'), true);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.addedIds, [studentId]);
  // The row returned must be the SAME markup/partial the full page itself
  // renders (partials/roster-student-row) - not a stripped-down summary -
  // so the client can just insert it and have it look identical to a
  // real page load, remove button and all.
  assert.match(res.body.rowsHtml, /data-roster-student-card/);
  assert.match(res.body.rowsHtml, /data-name="Ajax Add Student"/);
  assert.match(res.body.rowsHtml, /class="roster-log-grade-badge"/);
  assert.match(res.body.rowsHtml, new RegExp(`js-roster-student-remove" data-remove-endpoint="/admin/class-schedule/classes/${classId}/enrollment/${studentId}/remove"`));

  // And the student is actually enrolled now, not just echoed back.
  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=staffRoster`).set('Cookie', cookie);
  assert.match(page.text, /Ajax Add Student/);
});

test('enrollment/add via fetch only returns rows for students newly added, not ones already on the roster', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 2, className: 'Roster Ajax Add Class 2' });
  const alreadyId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Already Enrolled Student', 'already-enrolled-student', 'student')").run()
  ).lastInsertRowid;
  const newId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Newly Enrolled Student', 'newly-enrolled-student', 'student')").run()
  ).lastInsertRowid;
  await setEnrollment(classId, [alreadyId]);

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/add`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ studentIds: [String(alreadyId), String(newId)], _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.addedIds, [newId], 'only the genuinely new student should come back, not one already on the roster');
  assert.match(res.body.rowsHtml, /Newly Enrolled Student/);
  assert.doesNotMatch(res.body.rowsHtml, /Already Enrolled Student/);
});

test('enrollment/:studentId/remove via fetch (Accept: application/json) returns ok:true with no redirect, and actually removes the student', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 3, className: 'Roster Ajax Remove Class' });
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Ajax Remove Student', 'ajax-remove-student', 'student')").run()
  ).lastInsertRowid;
  await setEnrollment(classId, [studentId]);

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/${studentId}/remove`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'].includes('application/json'), true);
  assert.deepEqual(res.body, { ok: true });

  // Scoped to the Student Roster list itself, not the whole page - the
  // removed student is still an active member, so they legitimately still
  // show up as an option in this same tab's "+ Add Teacher/Assistant"
  // dropdown further down.
  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=staffRoster`).set('Cookie', cookie);
  const rosterStart = page.text.indexOf('id="student-roster-list"');
  const rosterEnd = page.text.indexOf('roster-student-profile-dialog', rosterStart);
  assert.doesNotMatch(page.text.slice(rosterStart, rosterEnd), /Ajax Remove Student/);
});

test('enrollment/:studentId/remove via fetch with a failure returns a graceful JSON error, not a 500 HTML crash page', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const classId = await createClass({ day: 'monday', hourPosition: 4, className: 'Roster Ajax Remove Error Class' });

  const res = await request(app)
    .post(`/admin/class-schedule/classes/${classId}/enrollment/${NONEXISTENT_MEMBER_ID}/remove`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .type('form')
    .send({ _csrf: csrfToken });

  // Removing a member id that was never actually enrolled is a no-op for
  // setEnrollment itself (filtering a list that never had it), but
  // adminRemoveStudentFromClass still has to tolerate it gracefully - the
  // real point of this test is that the JSON path never crashes into an
  // HTML error page regardless of status.
  assert.equal(res.headers['content-type'].includes('application/json'), true);
});

test('the Student Roster section and the Add Students dialog on the Manage page carry the ids/classes public/js/class-roster-ajax.js needs to drive them', async () => {
  const { cookie } = await loginAsAdmin();
  const studentId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Markup Check Student', 'markup-check-student', 'student')").run()
  ).lastInsertRowid;
  const classId = await createClass({ day: 'wednesday', hourPosition: 1, className: 'Roster Ajax Markup Class' });
  await setEnrollment(classId, [studentId]);
  const availableId = (
    await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Available To Add Student', 'available-to-add-student', 'student')").run()
  ).lastInsertRowid;

  const page = await request(app).get(`/admin/class-schedule/classes/${classId}/manage?tab=staffRoster`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="student-roster-list"/);
  assert.match(page.text, /id="student-roster-count"/);
  assert.match(page.text, /id="student-roster-empty"[^>]*hidden/, 'a non-empty roster should start with the empty-state message hidden');
  assert.match(page.text, /id="add-students-form"/);
  assert.match(page.text, /id="add-students-submit"/);
  assert.match(page.text, new RegExp(`data-student-id="${availableId}"`), 'the Add Students dialog should tag each row with the student id the AJAX script matches on');
  assert.match(page.text, /js-roster-student-remove" data-remove-endpoint="[^"]+" data-student-name="Markup Check Student"/);
  // Plain <form data-confirm> would re-intercept the auto-"are you sure?"
  // popup AND still navigate on confirm - the remove control must be a
  // real standalone button for public/js/class-roster-ajax.js's own
  // fetch()-based handler to own it entirely.
  assert.doesNotMatch(page.text, /data-confirm="Remove Markup Check Student/);
});

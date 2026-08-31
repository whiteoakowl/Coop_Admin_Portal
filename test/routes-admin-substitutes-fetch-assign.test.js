// A real request: "make it to where the page doesn't refresh every time
// you click assign or unassigned - it should simply assign and allow you
// to continue clicking assignment until you're done." routes/admin-
// substitutes.js's own assign/unassign routes now respond with JSON
// instead of a redirect when the request carries the app's own
// X-Requested-With: fetch header (see public/js/floater-assign.js), and
// routes/admin-volunteers.js grew a /fragment route that returns just the
// re-rendered cards grid so the client can swap it in without a full page
// navigation. A plain (non-fetch) form POST must still get the original
// redirect, so both response modes are exercised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-substitutes-fetch-assign-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-substitutes-fetch-assign-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');

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

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

test('assign via fetch (X-Requested-With header) returns JSON instead of redirecting, and actually saves', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 1, className: 'Fetch Assign Class', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Floater', 'fetch-floater-assign', 'parent')")
    .run();
  const date = '2026-09-07'; // a Monday
  const { classVacancySlotId } = require('../utils/substitutes');
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const assignRes = await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  assert.equal(assignRes.status, 200);
  assert.deepEqual(assignRes.body, { ok: true });

  const row = await db.prepare('SELECT slot_type FROM substitute_assignments WHERE session_date = ? AND slot_id = ?').get(date, slotId);
  assert.equal(row.slot_type, 'vacancy', 'the fetch-driven assign must have actually saved, same as a normal form POST');
});

test('assign via fetch surfaces a conflict error as JSON with a 400, not a redirect', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classA = await createClass({ day, hourPosition: 3, className: 'Conflict Class A', assistantSlots: 1 });
  const classB = await createClass({ day, hourPosition: 3, className: 'Conflict Class B', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Double Booked Floater', 'fetch-floater-conflict', 'parent')")
    .run();
  const date = '2026-09-07';
  const { classVacancySlotId, approveAssignment } = require('../utils/substitutes');
  const slotIdA = classVacancySlotId(classA, 'assistant', 1);
  const slotIdB = classVacancySlotId(classB, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotIdA), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });
  await approveAssignment(date, 'vacancy', slotIdA);

  const conflictRes = await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotIdB), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  assert.equal(conflictRes.status, 400);
  assert.equal(conflictRes.body.ok, false);
  assert.match(conflictRes.body.error, /already covering a different position/);
});

test('unassign via fetch returns JSON and deletes the assignment', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 4, className: 'Fetch Unassign Class', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Floater Two', 'fetch-floater-unassign', 'parent')")
    .run();
  const date = '2026-09-07';
  const { classVacancySlotId } = require('../utils/substitutes');
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  const unassignRes = await request(app)
    .post(`/admin/volunteers/${day}/substitutes/unassign`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), _csrf: csrfToken });

  assert.equal(unassignRes.status, 200);
  assert.deepEqual(unassignRes.body, { ok: true });

  const row = await db.prepare('SELECT * FROM substitute_assignments WHERE session_date = ? AND slot_id = ?').get(date, slotId);
  assert.equal(row, undefined);
});

test('a plain (non-fetch) form POST still gets the original redirect, unaffected by the new JSON branch', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 1, className: 'Plain Post Class', room: 'Room 5', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Plain Post Floater', 'plain-post-floater', 'parent')")
    .run();
  const date = '2026-09-07';
  const { classVacancySlotId } = require('../utils/substitutes');
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const assignRes = await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  assert.equal(assignRes.status, 302);
  assert.match(assignRes.headers.location, /\/admin\/volunteers\/monday\/manage/);
});

test('/fragment returns just the cards grid HTML (no <html>/<body>), reflecting current assignments', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 2, className: 'Fragment Class', room: 'Room 6', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fragment Floater', 'fragment-floater', 'parent')")
    .run();
  const date = '2026-09-07';
  const { classVacancySlotId } = require('../utils/substitutes');
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  // /fragment mirrors /manage's own upcomingDates restriction (see
  // routes/admin-volunteers.js), so the date has to actually be one of
  // this list's own session dates first - same as a real admin using the
  // Edit Dates dialog before the chart shows anything for it.
  await request(app)
    .post(`/admin/volunteers/${day}/dates/add?dialog=dates`)
    .set('Cookie', cookie)
    .type('form')
    .send({ dates: date, _csrf: csrfToken });

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  const fragRes = await request(app).get(`/admin/volunteers/${day}/fragment?date=${date}`).set('Cookie', cookie);
  assert.equal(fragRes.status, 200);
  assert.doesNotMatch(fragRes.text, /<html/);
  assert.match(fragRes.text, /Fragment Floater/);
  assert.match(fragRes.text, /floater-cards-grid/);
});

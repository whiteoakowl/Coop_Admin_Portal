// A real bug report: "the floater assignments that don't have a teacher
// or assistant on the roster therefore they appear on the floater
// assignments needed. when I click assign next to the position/name the
// page refreshes like normal, but the assign position doesn't save."
// routes/admin-substitutes.js's own /assign, /unassign, and /approve
// routes all collapsed any slotType other than 'job' down to 'class'
// (`req.body.slotType === 'job' ? 'job' : 'class'`) - fine for the two
// slot types that existed when that line was written, but 'vacancy' (a
// class's own unfilled teacher/assistant slot - see utils/substitutes.js's
// classVacancySlots) is a real third slot type, added later. A vacancy
// row's own Assign form correctly posts slotType=vacancy (views/partials/
// floater-chart-cards.ejs), but the route silently rewrote it to 'class'
// before saving - so the write landed under the wrong (slotType, slotId)
// key and the vacancy slot's own read path (which asks for slotType=
// 'vacancy') never found it again. The POST itself still 302-redirected
// normally, which is exactly why it looked like "the page refreshes like
// normal" while nothing was actually saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-substitutes-vacancy-assign-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-substitutes-vacancy-assign-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { substituteBoard, classVacancySlotId } = require('../utils/substitutes');

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

test('assigning a member to a vacancy slot actually persists (not silently rewritten to slotType=class)', async () => {
  const cookie = await loginAsAdmin();
  const day = 'monday';
  const classId = await createClass({ day, hourPosition: 1, className: 'Pottery Class', assistantSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Vacancy Floater', 'vacancy-floater-assign', 'parent')")
    .run();
  const date = '2026-09-07'; // a Monday
  const slotId = classVacancySlotId(classId, 'assistant', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  const assignRes = await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });
  assert.equal(assignRes.status, 302);

  const board = await substituteBoard(day, date);
  const hour = board.find((h) => h.position === 1);
  const slot = hour.slots.find((s) => s.slotType === 'vacancy' && s.slotId === slotId);
  assert.ok(slot, 'the vacancy slot should still be on the board');
  assert.ok(slot.assigned, 'the assignment should have actually saved');
  assert.equal(slot.assigned.id, memberId);

  const row = await db.prepare('SELECT slot_type FROM substitute_assignments WHERE session_date = ? AND slot_id = ?').get(date, slotId);
  assert.equal(row.slot_type, 'vacancy', 'must be stored under slotType=vacancy, not silently rewritten to class');
});

test('approving and unassigning a vacancy slot also use slotType=vacancy correctly', async () => {
  const cookie = await loginAsAdmin();
  const day = 'wednesday';
  const classId = await createClass({ day, hourPosition: 2, className: 'Woodworking Class', teacherSlots: 1 });
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Vacancy Floater Two', 'vacancy-floater-approve', 'parent')")
    .run();
  const date = '2026-09-09'; // a Wednesday
  const slotId = classVacancySlotId(classId, 'teacher', 1);

  const page = await request(app).get(`/admin/volunteers/${day}/manage?date=${date}`).set('Cookie', cookie);
  const csrfToken = extractCsrf(page.text);

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/assign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), memberId: String(memberId), isOverride: '1', _csrf: csrfToken });

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/approve`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), _csrf: csrfToken });

  let row = await db.prepare('SELECT status FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(date, 'vacancy', slotId);
  assert.equal(row.status, 'approved');

  await request(app)
    .post(`/admin/volunteers/${day}/substitutes/unassign`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slotType: 'vacancy', slotId: String(slotId), _csrf: csrfToken });

  row = await db.prepare('SELECT status FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(date, 'vacancy', slotId);
  assert.equal(row, undefined, 'unassign should have deleted the vacancy-slot assignment row');
});

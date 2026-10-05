// A real request: "also the registration schedule settings [should copy
// over to new semesters]", the same auto-clone treatment the Setup/
// Cleanup task list already got (test/routes-setup-task-list-semester-
// clone.test.js) - except here the admin explicitly chose to copy EVERY
// field exactly, opens_at/closes_at included, rather than blanking the
// dates for the new semester. See utils/registrationWindows.js's own
// cloneRegistrationWindowsFromMostRecentSemester for why class_schedule_id
// itself can't be copied verbatim (it has to be remapped to the new
// semester's own grid for the same day).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `registration-windows-semester-clone-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `registration-windows-semester-clone-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createWindow, listWindows } = require('../utils/registrationWindows');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

function extractCsrf(html) {
  return /name="csrf-token" content="([^"]*)"/.exec(html)[1];
}

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/schedule?tab=monday').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

async function createSemesterWithDays(admin, title, days) {
  await request(app)
    .post('/admin/schedule/semesters')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title, days, _csrf: admin.csrfToken });
  return db.prepare('SELECT * FROM semesters WHERE title = ?').get(title);
}

async function classScheduleIdFor(day, semesterId) {
  const row = await db.prepare('SELECT id FROM class_schedules WHERE day_of_week = ? AND semester_id = ?').get(day, semesterId);
  return row ? row.id : null;
}

test('creating a new semester clones its predecessor\'s Registration Windows exactly, remapping each to the new semester\'s own Schedule Grid', async () => {
  const admin = await loginAsAdmin();

  const fall = await createSemesterWithDays(admin, 'Clone Fall 2026', ['monday', 'wednesday']);
  const fallMonday = await classScheduleIdFor('monday', fall.id);
  const sectionId = (await db.prepare("INSERT INTO sections (name) VALUES ('Clone Test Section')").run()).lastInsertRowid;

  await createWindow({
    label: 'Fall Early Bird',
    opensAt: '2026-08-01 00:00:00',
    closesAt: '2026-08-15 00:00:00',
    classScheduleId: fallMonday,
    sectionIds: [sectionId],
    actionTypes: ['parent_register_student', 'student_register_self'],
  });

  const spring = await createSemesterWithDays(admin, 'Clone Spring 2027', ['monday', 'wednesday']);
  const springMonday = await classScheduleIdFor('monday', spring.id);

  const windows = await listWindows();
  const cloned = windows.find((w) => w.label === 'Fall Early Bird' && w.class_schedule_id === springMonday);
  assert.ok(cloned, 'the window should be cloned onto the new semester\'s own Monday grid');

  // Dates are copied EXACTLY, per the admin's own choice - not reset for the new semester.
  assert.equal(cloned.opens_at, '2026-08-01 00:00:00');
  assert.equal(cloned.closes_at, '2026-08-15 00:00:00');
  assert.equal(Number(cloned.open_for_parent_register_student), 1);
  assert.equal(Number(cloned.open_for_student_register_self), 1);
  assert.equal(Number(cloned.open_for_parent_teacher), 0);
  assert.equal(Number(cloned.open_for_parent_assistant), 0);
  assert.deepEqual(cloned.sectionIds, [sectionId]);

  // The original Fall window is untouched, still pointing at Fall's own grid.
  const original = windows.find((w) => w.label === 'Fall Early Bird' && w.class_schedule_id === fallMonday);
  assert.ok(original, 'the original window should still exist, unmodified');
});

test('a window with no Schedule Grid at all (applies to every grid already) is not re-cloned into the new semester', async () => {
  const admin = await loginAsAdmin();
  await db.prepare('DELETE FROM registration_windows').run();

  const fall = await createSemesterWithDays(admin, 'Universal Fall 2026', ['monday']);
  void fall;
  await createWindow({ label: 'Always Open', opensAt: '2026-01-01 00:00:00', closesAt: null, classScheduleId: null, sectionIds: [], actionTypes: [] });

  await createSemesterWithDays(admin, 'Universal Spring 2027', ['monday']);

  const windows = await listWindows();
  const matching = windows.filter((w) => w.label === 'Always Open');
  assert.equal(matching.length, 1, 'a grid-less window already applies to every semester, so it should not be duplicated');
});

test('a window scoped to a day the new semester does not meet is skipped, not cloned with a dangling reference', async () => {
  const admin = await loginAsAdmin();
  await db.prepare('DELETE FROM registration_windows').run();

  const fall = await createSemesterWithDays(admin, 'Friday Fall 2026', ['friday']);
  const fallFriday = await classScheduleIdFor('friday', fall.id);
  await createWindow({ label: 'Friday Only Window', opensAt: '2026-01-01 00:00:00', closesAt: null, classScheduleId: fallFriday, sectionIds: [], actionTypes: [] });

  // The next semester only meets Monday - no Friday grid to remap onto.
  await createSemesterWithDays(admin, 'Monday Only Spring 2027', ['monday']);

  const windows = await listWindows();
  const matching = windows.filter((w) => w.label === 'Friday Only Window');
  assert.equal(matching.length, 1, 'with no matching day in the new semester, the window should stay unduplicated rather than pointing nowhere');
});

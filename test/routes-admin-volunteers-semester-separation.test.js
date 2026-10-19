// A real bug report: "Floaters being needed for spring semester are still
// showing on fall semester. Make sure class schedule grids, individual
// classes, floaters, floater assignments, setup/cleanup, attendance,
// logs, EVERYTHING are separated by semester and the day... If there are
// more than one class with the same name it should still be separate in
// the system. Each numbered setup/cleanup tasks should have its own id
// even if there are more than one with the same name." Coverage for the
// two concrete fixes this led to in utils/substitutes.js: permanent_jobs
// (Floater Assignments' own recurring "Positions") now carries its own
// semester_id, and position groups are matched by a stable group_key
// instead of by title text (so two same-named positions - easy to get
// once the same title can exist in two different semesters - never get
// silently merged).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-semester-separation-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-semester-separation-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass, createSemester } = require('../utils/classSchedule');
const { setActiveKioskSemesterId } = require('../utils/kioskSettings');

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
  const page = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('a Permanent Position created under one semester does not show up when viewing a different semester\'s Floater Assignments page', async () => {
  const spring = await createSemester('Spring Separation Test');
  const fall = await createSemester('Fall Separation Test');
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post(`/admin/volunteers/monday/substitutes/permanent-jobs/new?semesterId=${fall.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, title: 'Fall Only Front Desk', room: '101', hourPositions: ['1'], date: '' });

  const fallPage = await request(app).get(`/admin/volunteers/monday/manage?semesterId=${fall.id}`).set('Cookie', cookie);
  assert.match(fallPage.text, /value="Fall Only Front Desk"/);

  const springPage = await request(app).get(`/admin/volunteers/monday/manage?semesterId=${spring.id}`).set('Cookie', cookie);
  assert.doesNotMatch(springPage.text, /Fall Only Front Desk/, 'a position created under Fall must not appear while viewing Spring');
});

test('two separate positions that happen to share a title (one per semester) stay fully separate - editing one never touches the other', async () => {
  const spring = await createSemester('Spring Title Clash');
  const fall = await createSemester('Fall Title Clash');
  const { cookie, csrfToken } = await loginAsAdmin();

  await request(app)
    .post(`/admin/volunteers/tuesday/substitutes/permanent-jobs/new?semesterId=${spring.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, title: 'Parking Lot', room: 'A', hourPositions: ['1'], date: '' });
  await request(app)
    .post(`/admin/volunteers/tuesday/substitutes/permanent-jobs/new?semesterId=${fall.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, title: 'Parking Lot', room: 'B', hourPositions: ['1'], date: '' });

  const rows = await db.prepare("SELECT id, semester_id, room, group_key FROM permanent_jobs WHERE day = 'tuesday' AND title = 'Parking Lot' ORDER BY semester_id").all();
  assert.equal(rows.length, 2, 'both same-named positions should exist as real, separate rows');
  assert.notEqual(rows[0].group_key, rows[1].group_key, 'two different positions sharing a title must never share a group_key');

  const springRow = rows.find((r) => r.semester_id === spring.id);
  const fallRow = rows.find((r) => r.semester_id === fall.id);

  // Edit the SPRING one's room through the real save-groups route - the
  // FALL one (same title, different semester) must be untouched. The
  // blank "Add New Position" row's own 3 fields (groups[new][...]) are
  // always present in a real browser submission even when left empty, so
  // this includes that same literal 'new' key too - without it, qs would
  // see only ONE numeric-looking key and silently (mis)parse the whole
  // groups object as a sparse array instead, which a real form post never
  // actually triggers.
  await request(app)
    .post(`/admin/volunteers/tuesday/substitutes/permanent-jobs/save-groups?semesterId=${spring.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      _csrf: csrfToken,
      date: '',
      groups: {
        [springRow.id]: { title: 'Parking Lot', room: 'Z', hours: ['1'] },
        new: { title: '', room: '', hours: [] },
      },
    });

  const springAfter = await db.prepare('SELECT room FROM permanent_jobs WHERE id = ?').get(springRow.id);
  const fallAfter = await db.prepare('SELECT room FROM permanent_jobs WHERE id = ?').get(fallRow.id);
  assert.equal(springAfter.room, 'Z', 'the Spring position should have been updated');
  assert.equal(fallAfter.room, 'B', 'the Fall position (same title) must still have its own original room, untouched');
});

test('substituteBoard\'s Substitutes Needed list only ever shows positions/vacancies for the semester actually being viewed', async () => {
  const spring = await createSemester('Spring Board Test');
  const fall = await createSemester('Fall Board Test');
  await setActiveKioskSemesterId(spring.id);

  const { cookie, csrfToken } = await loginAsAdmin();
  // A Fall-only recurring position.
  await request(app)
    .post(`/admin/volunteers/wednesday/substitutes/permanent-jobs/new?semesterId=${fall.id}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, title: 'Fall Setup Crew', room: '', hourPositions: ['1'], date: '' });

  // A Fall-only class with an unfilled teacher slot (a standing vacancy -
  // the exact "floaters needed" symptom from the real bug report).
  await createClass({ day: 'wednesday', hourPosition: 2, className: 'Fall Vacancy Class', semesterId: fall.id, teacherSlots: 1 });

  await addSessionDateHelper(cookie, csrfToken, 'wednesday', '2026-09-16', fall.id);

  const fallFragment = await request(app)
    .get(`/admin/volunteers/wednesday/fragment?date=2026-09-16&semesterId=${fall.id}`)
    .set('Cookie', cookie);
  assert.match(fallFragment.text, /Fall Setup Crew/, 'viewing Fall should show Fall\'s own recurring position');
  assert.match(fallFragment.text, /Fall Vacancy Class/, 'viewing Fall should show Fall\'s own class vacancy');

  const springFragment = await request(app)
    .get(`/admin/volunteers/wednesday/fragment?date=2026-09-16&semesterId=${spring.id}`)
    .set('Cookie', cookie);
  assert.doesNotMatch(springFragment.text, /Fall Setup Crew/, 'Spring\'s own Substitutes Needed board must not show a Fall-only position');
  assert.doesNotMatch(springFragment.text, /Fall Vacancy Class/, 'Spring\'s own Substitutes Needed board must not show a Fall-only class\'s vacancy');
});

async function addSessionDateHelper(cookie, csrfToken, day, date, semesterId) {
  await request(app)
    .post(`/admin/volunteers/${day}/dates/add?semesterId=${semesterId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, dates: [date] });
}

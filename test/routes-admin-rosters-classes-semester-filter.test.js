// A real request: "add semester choice dropdown settings to floater
// lists, floaters task lists, all classes, Monday/Wednesday attendance."
// Covers the Attendance > Classes tab's new Semester filter, the same
// client-reload-with-query-param shape Day/Hour already use there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-rosters-classes-semester-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-rosters-classes-semester-test-uploads-${process.pid}`);
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

test('Attendance > Classes tab offers a Semester filter once semesters exist, and it actually filters the list', async () => {
  const cookie = await loginAsAdmin();

  // No semesters yet - the dropdown shouldn't render at all. (The Day/Hour
  // selects' own onchange handlers reference the id defensively even when
  // it's absent, so this checks for the actual <select> tag, not just the
  // bare id substring.)
  const before = await request(app).get('/admin/rosters?tab=classes').set('Cookie', cookie);
  assert.doesNotMatch(before.text, /<select id="class-roster-semester-select"/);

  const fall = await db.prepare('INSERT INTO semesters (title) VALUES (?) RETURNING *').get('Fall 2026');
  const spring = await db.prepare('INSERT INTO semesters (title) VALUES (?) RETURNING *').get('Spring 2027');
  await createClass({ day: 'monday', hourPosition: 1, className: 'Fall Class', semesterId: fall.id });
  await createClass({ day: 'monday', hourPosition: 2, className: 'Spring Class', semesterId: spring.id });
  await createClass({ day: 'monday', hourPosition: 3, className: 'No Semester Class', semesterId: null });

  const all = await request(app).get('/admin/rosters?tab=classes').set('Cookie', cookie);
  assert.match(all.text, /<select id="class-roster-semester-select"/);
  assert.match(all.text, /Fall Class/);
  assert.match(all.text, /Spring Class/);
  assert.match(all.text, /No Semester Class/);

  const fallOnly = await request(app).get(`/admin/rosters?tab=classes&semesterId=${fall.id}`).set('Cookie', cookie);
  assert.match(fallOnly.text, /Fall Class/);
  assert.doesNotMatch(fallOnly.text, /Spring Class/);
  assert.doesNotMatch(fallOnly.text, /No Semester Class/);

  const noSemesterOnly = await request(app).get('/admin/rosters?tab=classes&semesterId=none').set('Cookie', cookie);
  assert.match(noSemesterOnly.text, /No Semester Class/);
  assert.doesNotMatch(noSemesterOnly.text, /Fall Class/);
  assert.doesNotMatch(noSemesterOnly.text, /Spring Class/);
});

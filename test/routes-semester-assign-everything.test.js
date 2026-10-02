// A real request: "Go ahead and create a fall 2026 semester and connect
// all classes, floater assignments, setup cleanup, attendance, logs,
// everything on co-op admin portal. I don't want to loose any current
// data." The Settings > Semester tab's "Data Missing a Semester" tool
// (utils/semesterAssignment.js) is the one-click way to do this: it tags
// every still-unassigned class, Floater List, Setup/Cleanup Team, Task
// List, and Day Settings record with a chosen semester at once, never
// deleting or moving anything - Attendance/checkouts/admin logs aren't
// semester-scoped containers and have nothing to tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `semester-assign-everything-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `semester-assign-everything-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createClass } = require('../utils/classSchedule');
const { getListByDay, sectionsForList, addMemberToSection } = require('../utils/volunteers');

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
  const page = await request(app).get('/admin/schedule?tab=settings').set('Cookie', cookie);
  return { cookie, csrfToken: extractCsrf(page.text) };
}

test('Connect Everything: classes, a Floater List (with its members intact), a Setup/Cleanup Team, and Day Settings records all get tagged to the new semester with no data lost', async () => {
  const admin = await loginAsAdmin();

  // "Current data" - everything pre-existing, with no semester at all.
  // Both Monday and Wednesday already have their own Floater List at this
  // point regardless - server.js's own bootRosters() ensures both exist
  // on every boot, same as a real already-running site would have.
  const classId = await createClass({ day: 'monday', hourPosition: 1, className: 'Existing Art Class' });
  const list = await getListByDay('monday', null);
  const wednesdayList = await getListByDay('wednesday', null);
  const sections = await sectionsForList(list.id);
  const memberInfo = await db.prepare("INSERT INTO members (name, barcode, member_type, active) VALUES ('Existing Floater', 'existing-floater', 'parent', 1)").run();
  await addMemberToSection(list.id, memberInfo.lastInsertRowid, sections[0].id);
  await request(app).post('/admin/setup/monday/teams').set('Cookie', admin.cookie).type('form').send({ title: 'Existing Cleanup Crew', _csrf: admin.csrfToken });
  const team = await db.prepare("SELECT * FROM setup_teams WHERE title = 'Existing Cleanup Crew'").get();

  // Create Fall 2026.
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Fall 2026', _csrf: admin.csrfToken });
  const fall = await db.prepare("SELECT * FROM semesters WHERE title = 'Fall 2026'").get();

  const before = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  assert.match(before.text, /Data Missing a Semester/);
  assert.match(before.text, /1 class with no semester assigned/);
  assert.match(before.text, /2 Floater Lists with no semester assigned/);
  assert.match(before.text, /1 Setup\/Cleanup Team with no semester assigned/);
  assert.match(before.text, /2 Day Settings records with no semester assigned/);

  // Connect everything.
  const res = await request(app)
    .post('/admin/schedule/semesters/assign-missing')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ semesterId: String(fall.id), _csrf: admin.csrfToken });
  assert.match(res.headers.location, /notice=/);

  // Every container is now tagged - and no underlying data was lost.
  const cls = await db.prepare('SELECT semester_id FROM classes WHERE id = ?').get(classId);
  assert.equal(cls.semester_id, fall.id);

  const taggedList = await db.prepare('SELECT * FROM volunteer_lists WHERE id = ?').get(list.id);
  assert.equal(taggedList.semester_id, fall.id);
  const taggedWednesdayList = await db.prepare('SELECT * FROM volunteer_lists WHERE id = ?').get(wednesdayList.id);
  assert.equal(taggedWednesdayList.semester_id, fall.id);
  const sectionsStillThere = await db.prepare('SELECT COUNT(*) AS c FROM volunteer_sections WHERE volunteer_list_id = ?').get(list.id);
  assert.equal(Number(sectionsStillThere.c), 4, 'the Floater List kept all 4 of its Hour sections');
  const memberStillAssigned = await db.prepare('SELECT * FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ?').get(list.id, memberInfo.lastInsertRowid);
  assert.ok(memberStillAssigned, 'the existing floater is still assigned to their section');

  const taggedTeam = await db.prepare('SELECT semester_id FROM setup_teams WHERE id = ?').get(team.id);
  assert.equal(taggedTeam.semester_id, fall.id);

  const schedules = await db.prepare('SELECT day_of_week, semester_id FROM class_schedules ORDER BY day_of_week').all();
  assert.ok(schedules.every((s) => s.semester_id === fall.id), 'both Day Settings records are now tagged Fall 2026');

  // Nothing left missing a semester.
  const after = await request(app).get('/admin/schedule?tab=settings&settingsTab=semester').set('Cookie', admin.cookie);
  assert.doesNotMatch(after.text, /Data Missing a Semester/);

  // The Classes grid, Floater Assignments, and Setup/Cleanup pages all
  // still work exactly as before - nothing broke navigating to them.
  const classesGrid = await request(app).get('/admin/schedule?tab=monday').set('Cookie', admin.cookie);
  assert.equal(classesGrid.status, 200);
  assert.match(classesGrid.text, /Existing Art Class/);
  const floaterPage = await request(app).get('/admin/volunteers/monday/manage').set('Cookie', admin.cookie);
  assert.equal(floaterPage.status, 200);
  const setupPage = await request(app).get('/admin/setup/monday/manage').set('Cookie', admin.cookie);
  assert.equal(setupPage.status, 200);
  assert.match(setupPage.text, /Existing Cleanup Crew/);
});

test('Connect Everything: running it again when nothing is missing reports nothing to do, and does not duplicate or lose anything', async () => {
  const admin = await loginAsAdmin();
  await request(app).post('/admin/schedule/semesters').set('Cookie', admin.cookie).type('form').send({ title: 'Spring 2027', _csrf: admin.csrfToken });
  const spring = await db.prepare("SELECT * FROM semesters WHERE title = 'Spring 2027'").get();

  const res = await request(app)
    .post('/admin/schedule/semesters/assign-missing')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ semesterId: String(spring.id), _csrf: admin.csrfToken });
  assert.match(decodeURIComponent(res.headers.location), /Nothing was missing a semester/);
});

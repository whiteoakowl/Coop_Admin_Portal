// Phase 2 of the 7-day expansion ("Full 7 day expansion so multiple
// semesters can be created and managed... all the floater and setup
// cleanup features for each to go with it" - a real request). Phase 1
// let the Classes grid offer any day of the week via Settings > Day
// Settings; this covers that Floater Assignments and Setup/Cleanup can
// now do the same for that day - their own day columns (widened in
// 20261026010000_volunteers_setup_day_expansion.sql), their admin day-
// toggles, and their public kiosk day-pickers all adapt to whichever days
// are active, not a hardcoded Monday/Wednesday pair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `volunteers-setup-day-expansion-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `volunteers-setup-day-expansion-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

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

async function activateThursday(admin) {
  await request(app)
    .post('/admin/schedule/class-schedules')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Thursday Enrichment', dayOfWeek: 'thursday', _csrf: admin.csrfToken });
}

test('Floater Assignments: a newly-activated day (Thursday) gets its own admin day-toggle entry and a working manage page', async () => {
  const admin = await loginAsAdmin();
  await activateThursday(admin);

  const manage = await request(app).get('/admin/volunteers/thursday/manage').set('Cookie', admin.cookie);
  assert.equal(manage.status, 200);
  // The plain Monday/Wednesday day-toggle (<a>Thursday</a> pill links) is
  // now the semester+day combo picker (a real request: "I need to be
  // able to switch between semester views on floaters... drop down on
  // all these pages") - a <select> whose <option>s are every
  // class_schedules row. None of these three has a semester tag, so each
  // just reads its plain day name.
  assert.match(manage.text, />Thursday<\/option>/);
  assert.match(manage.text, />Monday<\/option>/);
  assert.match(manage.text, />Wednesday<\/option>/);

  const list = await db.prepare("SELECT * FROM volunteer_lists WHERE day = 'thursday'").get();
  assert.ok(list, 'a volunteer_lists row for Thursday should have been created');
  const sections = await db.prepare('SELECT * FROM volunteer_sections WHERE volunteer_list_id = ?').all(list.id);
  assert.equal(sections.length, 4);
});

test('Floater Assignments: the public kiosk day-picker lists every active day, not a hardcoded Monday/Wednesday pair', async () => {
  const admin = await loginAsAdmin();
  await activateThursday(admin);

  const picker = await request(app).get('/volunteers');
  assert.equal(picker.status, 200);
  assert.match(picker.text, /href="\/volunteers\/monday"/);
  assert.match(picker.text, /href="\/volunteers\/wednesday"/);
  assert.match(picker.text, /href="\/volunteers\/thursday"/);

  const chart = await request(app).get('/volunteers/thursday');
  assert.equal(chart.status, 200);
});

test('Setup/Cleanup: a Thursday team is creatable, shows on the admin day-toggle, and the public kiosk day-picker includes Thursday', async () => {
  const admin = await loginAsAdmin();
  await activateThursday(admin);

  const createTeam = await request(app)
    .post('/admin/setup/thursday/teams')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Thursday Cleanup Crew', _csrf: admin.csrfToken });
  assert.notEqual(createTeam.status, 404);

  const team = await db.prepare("SELECT * FROM setup_teams WHERE day = 'thursday'").get();
  assert.ok(team, 'a setup_teams row for Thursday should have been created');
  assert.equal(team.title, 'Thursday Cleanup Crew');

  const manage = await request(app).get('/admin/setup/thursday/manage').set('Cookie', admin.cookie);
  assert.equal(manage.status, 200);
  assert.match(manage.text, /Thursday Cleanup Crew/);
  // The plain Monday/Wednesday day-toggle (<a>Thursday</a> pill links) is
  // now the semester+day combo picker (a real request: "I need to be
  // able to switch between semester views on floaters, setup cleanup...
  // drop down on all these pages") - a <select> whose <option>s are every
  // class_schedules row. None of these three has a semester tag, so each
  // just reads its plain day name.
  assert.match(manage.text, />Thursday<\/option>/);
  assert.match(manage.text, />Monday<\/option>/);
  assert.match(manage.text, />Wednesday<\/option>/);

  const picker = await request(app).get('/setup');
  assert.equal(picker.status, 200);
  assert.match(picker.text, /href="\/setup\/thursday"/);

  const publicView = await request(app).get('/setup/thursday');
  assert.equal(publicView.status, 200);
  assert.match(publicView.text, /Thursday Cleanup Crew/);
});

test('Setup/Cleanup: a Thursday task list section and its dates/assignments all work end to end', async () => {
  const admin = await loginAsAdmin();
  await activateThursday(admin);

  const tasksPage = await request(app).get('/admin/setup/thursday/tasks').set('Cookie', admin.cookie);
  assert.equal(tasksPage.status, 200);

  await request(app)
    .post('/admin/setup/thursday/tasks/new')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ title: 'Thursday Task List', _csrf: admin.csrfToken });
  const section = await db.prepare("SELECT * FROM task_list_sections WHERE day = 'thursday'").get();
  assert.ok(section, 'a task_list_sections row for Thursday should have been created');

  await request(app)
    .post('/admin/setup/thursday/dates/add')
    .set('Cookie', admin.cookie)
    .type('form')
    .send({ dates: '2026-10-29', _csrf: admin.csrfToken });
  const date = await db.prepare("SELECT * FROM setup_dates WHERE day = 'thursday'").get();
  assert.ok(date, 'a setup_dates row for Thursday should have been created');

  const assignments = await request(app).get('/admin/setup/thursday/assignments').set('Cookie', admin.cookie);
  assert.equal(assignments.status, 200);
});

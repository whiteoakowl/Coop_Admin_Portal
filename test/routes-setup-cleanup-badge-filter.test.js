// Coverage for a real request: "Print setup/cleanup badges. Add a filter
// button. Filter popup included dropdown to select team and dropdown to
// select semester or all." Each setupCleanup misc_badges row now carries
// its own team_id/semester_id (utils/taskList.js's upsertTaskBadge,
// mirroring how day/leader_name were already denormalized onto it), and
// the print panel (partials/misc-badge-print-panel.ejs) stamps that onto
// each row as data-team-id/data-semester-id for design-print-hub.js's own
// wireMiscBadgeTeamSemesterFilter to filter against client-side.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-cleanup-badge-filter-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-cleanup-badge-filter-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';
process.env.MAIN_ADMIN_EMAIL = 'mainadmin@coop.local';
process.env.MAIN_ADMIN_PASSWORD = 'changeme123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { createSection, addItem, updateItem } = require('../utils/taskList');
const { createSemester } = require('../utils/classSchedule');
const { updateTeam } = require('../utils/setup');

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
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

async function createTeam(day, title, semesterId) {
  const row = await db.prepare('INSERT INTO setup_teams (day, title, semester_id) VALUES (?, ?, ?) RETURNING id').get(day, title, semesterId);
  return row.id;
}

test('a task under a team gets its badge stamped with that team\'s id and the section\'s semester id', async () => {
  const semester = await createSemester('Filter Test Semester');
  const teamId = await createTeam('monday', 'Kitchen Crew', semester.id);
  const sectionId = await createSection('monday', 'Kitchen Tasks', teamId, semester.id);
  const itemId = await addItem(sectionId, 'Wipe the counters');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);
  assert.equal(badge.team_id, teamId);
  assert.equal(badge.semester_id, semester.id);
});

test('a task under a section with no linked team still gets the section\'s own semester id, with a null team id', async () => {
  const semester = await createSemester('Unlinked Section Semester');
  const sectionId = await createSection('wednesday', 'Loose Tasks', null, semester.id);
  const itemId = await addItem(sectionId, 'Sweep the hallway');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);
  assert.equal(badge.team_id, null);
  assert.equal(badge.semester_id, semester.id);
});

test('editing a task\'s description keeps its badge\'s team/semester id intact', async () => {
  const semester = await createSemester('Edit Keeps Ids Semester');
  const teamId = await createTeam('monday', 'Yard Crew', semester.id);
  const sectionId = await createSection('monday', 'Yard Tasks', teamId, semester.id);
  const itemId = await addItem(sectionId, 'Rake leaves');
  await updateItem(itemId, 'Rake leaves by the front door');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);
  assert.equal(badge.team_id, teamId);
  assert.equal(badge.semester_id, semester.id);
  assert.equal(badge.description, 'Rake leaves by the front door');
});

test('renaming a team (updateTeam) keeps its already-printed badges\' team id intact', async () => {
  const semester = await createSemester('Rename Keeps Id Semester');
  const teamId = await createTeam('monday', 'Original Name', semester.id);
  const sectionId = await createSection('monday', 'Renamed Team Tasks', teamId, semester.id);
  const itemId = await addItem(sectionId, 'Take out recycling');
  await updateTeam(teamId, { title: 'Brand New Name' });
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);
  assert.equal(badge.team_id, teamId);
  assert.equal(badge.title, 'Brand New Name');
});

test('Design/Print page: the Setup/Cleanup Badges panel has a Filter button opening a dialog with Team and Semester dropdowns, but the Custom Badges panel does not', async () => {
  const semester = await createSemester('Dropdown Options Semester');
  const teamId = await createTeam('wednesday', 'Dropdown Team', semester.id);
  const sectionId = await createSection('wednesday', 'Dropdown Tasks', teamId, semester.id);
  const itemId = await addItem(sectionId, 'Stack the chairs');
  const badge = await db.prepare('SELECT * FROM misc_badges WHERE task_item_id = ?').get(itemId);

  const { cookie } = await loginAsAdmin();
  const page = await request(app).get('/admin/design?tab=print').set('Cookie', cookie);
  assert.equal(page.status, 200);

  // The Filter button and its dialog only exist for the setupCleanup panel.
  assert.match(page.text, /id="setupCleanup-badge-filter-dialog"/);
  assert.doesNotMatch(page.text, /id="custom-badge-filter-dialog"/);
  assert.match(page.text, /onclick="document\.getElementById\('setupCleanup-badge-filter-dialog'\)\.showModal\(\)">Filter<\/button>/);

  // Team dropdown lists the real team, labeled with its day.
  assert.match(page.text, new RegExp(`<option value="${teamId}">\\[Wednesday\\] Dropdown Team</option>`));
  // Semester dropdown lists the real semester.
  assert.match(page.text, new RegExp(`<option value="${semester.id}">Dropdown Options Semester</option>`));
  // Both default to "All".
  assert.match(page.text, /<option value="">All Teams<\/option>/);
  assert.match(page.text, /<option value="">All Semesters<\/option>/);

  // The badge's own row carries the matching data attributes for the
  // client-side filter (design-print-hub.js) to key off of.
  const rowMatch = new RegExp(`data-team-id="${teamId}" data-semester-id="${semester.id}"[\\s\\S]{0,200}value="${badge.id}"`).exec(page.text);
  assert.ok(rowMatch, 'expected the badge row to carry its own team/semester data attributes');
});

test('Main Admin Name Tags page: the same Filter dialog renders there too, reusing the shared panel', async () => {
  const loginRes = await request(app).post('/login').type('form').send({ email: process.env.MAIN_ADMIN_EMAIL, password: process.env.MAIN_ADMIN_PASSWORD, next: '/main-admin' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/main-admin/name-tags?tab=print').set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="setupCleanup-badge-filter-dialog"/);
});

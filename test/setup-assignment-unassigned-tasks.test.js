// A real user request: "At the bottom of the setup/cleanup assignment
// cards. Any tasks that are not assigned to a member on the card should
// be listed with the title Unassigned tasks. As the tasks are assigned
// they will disappear from the Unassigned list." Covers routes/admin-
// setup.js's assignmentCardsForDate unassignedTasks computation and
// views/partials/setup-assignment-cards.ejs's own rendering of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-assignment-unassigned-tasks-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-assignment-unassigned-tasks-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

// A real bug: this test used to hardcode a specific far-future date
// string as its session date - safely in the future when written, but a
// literal calendar date eventually stops being "future" as real time
// passes (exactly what happened here). Computed fresh relative to the
// real clock every run instead - always a real Monday, always at least
// 3 weeks out, so it stays valid indefinitely. Both tests in this file
// call this and get the SAME date back (same real "now", same math),
// which the second test's own comment already relies on.
function futureMonday() {
  let d = addDays(todayISO(), 21);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

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

function extractUnassignedBlock(html) {
  const match = /<div class="setup-unassigned-tasks">[^]*?<\/div>/.exec(html);
  return match ? match[0] : null;
}

test('unassigned tasks are listed at the bottom of the card and drop off once assigned', async () => {
  const cookie = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Unassigned Tasks Team')").run();
  const section = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Unassigned Tasks', ?, 0)")
    .run(team.lastInsertRowid);
  await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Sweep floor');
  await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)').run(section.lastInsertRowid, 'Take out trash');

  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Uma Ellis', 'unassigned-uma', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  const date = futureMonday();
  await db.prepare("INSERT INTO setup_dates (day, session_date) VALUES ('monday', ?)").run(date);

  const before = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  assert.equal(before.status, 200);
  const beforeBlock = extractUnassignedBlock(before.text);
  assert.ok(beforeBlock, 'expected an Unassigned Tasks block when nothing is assigned yet');
  assert.match(beforeBlock, /Unassigned Tasks/);
  assert.match(beforeBlock, /Sweep floor/);
  assert.match(beforeBlock, /Take out trash/);

  const csrfMatch = /name="csrf-token" content="([^"]*)"/.exec(before.text);
  const csrfToken = csrfMatch[1];

  const sweepId = (await db.prepare("SELECT id FROM task_list_items WHERE description = 'Sweep floor'").get()).id;
  const assignRes = await request(app)
    .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, date, slot: '1', taskItemId: String(sweepId) });
  assert.equal(assignRes.status, 302);

  const after = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  const afterBlock = extractUnassignedBlock(after.text);
  assert.ok(afterBlock, 'expected an Unassigned Tasks block to still exist (one task is still unassigned)');
  assert.doesNotMatch(afterBlock, /Sweep floor/, 'the now-assigned task should have dropped off the Unassigned Tasks list');
  assert.match(afterBlock, /Take out trash/, 'the still-unassigned task should remain listed');
});

test('the Unassigned Tasks block is omitted entirely once every task is assigned', async () => {
  const cookie = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Fully Assigned Team')").run();
  const section = await db
    .prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Fully Assigned Tasks', ?, 0)")
    .run(team.lastInsertRowid);
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Wipe tables');

  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Finn Grant', 'unassigned-finn', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  // Same session date the previous test already added for 'monday' -
  // setup_dates has no per-row id (just a day+session_date pair), and
  // this file's two tests share one DB, so it's already there.
  const date = futureMonday();

  const page = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];

  await request(app)
    .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken, date, slot: '1', taskItemId: String(item.lastInsertRowid) });

  const res = await request(app).get(`/admin/setup/monday/assignments?date=${date}`).set('Cookie', cookie);
  // Both this team's card and the other test's still-partly-unassigned
  // team share the page, so scope the check to just this team's own
  // section of the response rather than the whole page.
  const teamHtml = res.text.slice(res.text.indexOf('Fully Assigned Team'), res.text.indexOf('Fully Assigned Team') + 2000);
  assert.doesNotMatch(teamHtml, /setup-unassigned-tasks/, 'no Unassigned Tasks block once every task on the team is assigned');
});

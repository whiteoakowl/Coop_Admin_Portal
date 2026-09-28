// A real request: "Do not refresh the page every time you assign or
// unassigned a setup/cleanup task. Should be able to keep assigning all
// at once." routes/admin-setup.js's /assignments/:memberId/task route now
// responds with JSON instead of a redirect when the request carries the
// app's own X-Requested-With: fetch header (see public/js/setup-assign.js),
// and a new /assignments/fragment route returns just the re-rendered
// cards so the client can swap it in without a full page navigation.
// Mirrors test/routes-admin-substitutes-fetch-assign.test.js's own
// coverage for the identical fix on the Floater Chart. A plain (non-fetch)
// form POST must still get the original redirect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-assignments-fetch-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-assignments-fetch-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { todayISO, addDays, weekdayOf } = require('../utils/dates');

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
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

let seedCounter = 0;
async function seedTeamWithTask(date, cookie, csrfToken) {
  const n = ++seedCounter;
  const team = await db.prepare('INSERT INTO setup_teams (day, title) VALUES (?, ?)').run('monday', `Fetch Crew ${n}`);
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Fetch Tasks', ?, 0)").run(team.lastInsertRowid);
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Sweep the floor');
  const member = await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(`Fetch Member ${n}`, `fetch-setup-member-${n}`, 'parent');
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);
  await request(app).post('/admin/setup/monday/dates/add').set('Cookie', cookie).type('form').send({ dates: date, _csrf: csrfToken });
  return { teamId: team.lastInsertRowid, memberId: member.lastInsertRowid, taskItemId: item.lastInsertRowid };
}

test('assign via fetch (X-Requested-With header) returns JSON instead of redirecting, and actually saves', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const date = futureMonday();
  const { memberId, taskItemId } = await seedTeamWithTask(date, cookie, csrfToken);

  const res = await request(app)
    .post(`/admin/setup/monday/assignments/${memberId}/task`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', memberId, date);
  assert.equal(row.task_item_id, taskItemId, 'the fetch-driven assign must have actually saved, same as a normal form POST');
});

test('unassign via fetch returns JSON and clears the assignment', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const date = futureMonday();
  const { memberId, taskItemId } = await seedTeamWithTask(date, cookie, csrfToken);
  await request(app)
    .post(`/admin/setup/monday/assignments/${memberId}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  const res = await request(app)
    .post(`/admin/setup/monday/assignments/${memberId}/task`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slot: '1', taskItemId: '', _csrf: csrfToken });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });

  const row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', memberId, date);
  assert.equal(row, undefined);
});

test('assign via fetch surfaces a conflict error as JSON with a 400, not a redirect', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const date = futureMonday();
  const { teamId, memberId: memberA, taskItemId } = await seedTeamWithTask(date, cookie, csrfToken);
  const memberB = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Member Conflict B', 'fetch-setup-member-conflict-b', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberB.lastInsertRowid);

  await request(app)
    .post(`/admin/setup/monday/assignments/${memberA}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  const conflictRes = await request(app)
    .post(`/admin/setup/monday/assignments/${memberB.lastInsertRowid}/task`)
    .set('Cookie', cookie)
    .set('X-Requested-With', 'fetch')
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  assert.equal(conflictRes.status, 400);
  assert.equal(conflictRes.body.ok, false);
  assert.match(conflictRes.body.error, /already been assigned to someone else/);
});

test('a plain (non-fetch) form POST still gets the original redirect, unaffected by the new JSON branch', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const date = futureMonday();
  const { memberId, taskItemId } = await seedTeamWithTask(date, cookie, csrfToken);

  const res = await request(app)
    .post(`/admin/setup/monday/assignments/${memberId}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/setup\/monday\/assignments/);
});

test('/assignments/fragment returns just the cards HTML (no <html>/<body>), reflecting current assignments', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const date = futureMonday();
  const { memberId, taskItemId } = await seedTeamWithTask(date, cookie, csrfToken);

  await request(app)
    .post(`/admin/setup/monday/assignments/${memberId}/task`)
    .set('Cookie', cookie)
    .type('form')
    .send({ date, slot: '1', taskItemId: String(taskItemId), _csrf: csrfToken });

  const fragRes = await request(app).get(`/admin/setup/monday/assignments/fragment?date=${date}`).set('Cookie', cookie);
  assert.equal(fragRes.status, 200);
  assert.doesNotMatch(fragRes.text, /<html/);
  assert.match(fragRes.text, /Sweep the floor/);
  assert.match(fragRes.text, /setup-assignment-cards-grid/);
});

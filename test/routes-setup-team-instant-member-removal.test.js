// Real HTTP-level coverage for a real request: "setup/cleanup teams. when
// editing the team, if you click the trash button the member name should
// automatically go away without having to save the team or refreshing the
// page." Replaces the old stage-until-Save checkbox (still how Floater
// Teams' own trash icon works - see test/routes-team-batched-member-
// removal.test.js) with an immediate removal: the trash button
// (public/js/team-member-instant-remove.js) posts straight to its own
// data-member-remove-url, and routes/admin-setup.js's /remove-member/
// :memberId route now answers with JSON when asked for it instead of
// always redirecting, so the row can disappear from the DOM without a
// page reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `setup-team-instant-remove-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `setup-team-instant-remove-test-uploads-${process.pid}`);
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

async function loginAsAdmin() {
  const loginRes = await request(app).post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123' });
  const cookie = loginRes.headers['set-cookie'];
  const page = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Setup/Cleanup Teams card markup: the trash icon posts straight to its own remove-member URL - no hidden stage-until-Save checkbox', async () => {
  const { cookie } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Instant Remove Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Instant Remove Member', 'Instant Remove Member', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.match(
    res.text,
    new RegExp(`data-edit-toggle-reveal hidden data-member-instant-remove-btn data-member-remove-url="/admin/setup/monday/teams/${teamId}/remove-member/${memberId}\\?semesterId=`)
  );
  assert.doesNotMatch(res.text, /name="removeMemberIds"/, 'the old stage-until-Save checkbox should be gone from this card');
  assert.match(res.text, /<script src="\/js\/team-member-instant-remove\.js"><\/script>/);
  assert.doesNotMatch(res.text, /team-member-remove-toggle\.js/, 'the old staged-removal script should no longer load on this page');
});

test('POST /remove-member/:memberId with Accept: application/json removes the member and responds with JSON, not a redirect', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Fetch Remove Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Fetch Removed Member', 'Fetch Removed Member', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app)
    .post(`/admin/setup/monday/teams/${teamId}/remove-member/${memberId}`)
    .set('Cookie', cookie)
    .set('Accept', 'application/json')
    .set('X-CSRF-Token', csrfToken)
    .type('form')
    .send({});
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/json');
  assert.deepEqual(res.body, { ok: true });

  const remaining = await db.prepare('SELECT 1 FROM setup_team_members WHERE team_id = ? AND member_id = ?').get(teamId, memberId);
  assert.equal(remaining, undefined, 'the member should actually be removed from the team');
});

test('a plain (non-JSON) POST to /remove-member/:memberId still redirects, unaffected by the JSON path', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Plain Remove Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Plain Removed Member', 'Plain Removed Member', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app)
    .post(`/admin/setup/monday/teams/${teamId}/remove-member/${memberId}`)
    .set('Cookie', cookie)
    .type('form')
    .send({ _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/setup\/monday\/manage/);

  const remaining = await db.prepare('SELECT 1 FROM setup_team_members WHERE team_id = ? AND member_id = ?').get(teamId, memberId);
  assert.equal(remaining, undefined, 'the member should still actually be removed');
});

test('a plain Save (POST /teams/:teamId/edit with no removeMemberIds) only ever updates team fields now - member removal is not part of this submission at all', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Edit Only Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Stays On Team', 'Stays On Team', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app)
    .post(`/admin/setup/monday/teams/${teamId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    // Even if an old client somehow still sent removeMemberIds, the route
    // no longer reads it at all - this proves it's inert, not just unused.
    .send({ title: 'Edit Only Team Renamed', leaderId: '', removeMemberIds: [String(memberId)], _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.doesNotMatch(decodeURIComponent(res.headers.location), /Removed/);

  const teamRow = await db.prepare('SELECT title FROM setup_teams WHERE id = ?').get(teamId);
  assert.equal(teamRow.title, 'Edit Only Team Renamed');

  const remaining = await db.prepare('SELECT 1 FROM setup_team_members WHERE team_id = ? AND member_id = ?').get(teamId, memberId);
  assert.ok(remaining, 'removeMemberIds on the edit route must no longer remove anyone - that only happens via the dedicated remove-member route now');
});

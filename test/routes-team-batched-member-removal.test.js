// Real HTTP-level coverage for a real request: "when deleting floaters
// and cleanup/signup members from lists it should allow for multiple
// deletes and then click save before refreshing." Both Floater Teams
// (routes/admin-volunteers.js's hour-label route) and Setup/Cleanup Teams
// (routes/admin-setup.js's team edit route) now accept a batch of
// removeMemberIds riding along with their existing Save submission,
// instead of each member's own trash icon submitting an immediate,
// separate POST/reload - this proves the batch actually removes every
// listed member in one request, and (for Floater Teams specifically) that
// the removal survives the same later re-sync that a real bug report once
// silently undid a single removal across (see test/routes-admin-
// volunteers-floater-remove-sticks.test.js, the fix this batch path
// reuses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `team-batched-remove-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `team-batched-remove-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const { syncDayMemberRosters } = require('../utils/classSchedule');
const { getListByDay, sectionsForList } = require('../utils/volunteers');

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
  const page = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('Floater Teams card markup: the trash icon is a plain button wired to a hidden, form-linked checkbox, not its own immediate-submit form', async () => {
  const { cookie } = await loginAsAdmin();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Batch Remove Floater', 'Batch Remove Floater', 'parent')")
    .run();
  const list = await getListByDay('monday');
  const section = (await sectionsForList(list.id))[0];
  await db.prepare("INSERT INTO volunteer_members (volunteer_list_id, section_id, member_id, rank) VALUES (?, ?, ?, 'sometimes')").run(list.id, section.id, memberId);

  const res = await request(app).get('/admin/volunteers/monday/teams').set('Cookie', cookie);
  assert.match(res.text, new RegExp(`<input type="checkbox" name="removeMemberIds" value="${memberId}" form="hour-edit-form-${section.id}" hidden data-member-remove-checkbox`));
  assert.doesNotMatch(res.text, new RegExp(`action="/admin/volunteers/monday/teams/${section.id}/members/${memberId}/remove"`));
  assert.match(res.text, /<script src="\/js\/team-member-remove-toggle\.js"><\/script>/);
});

test('Floater Teams: removing 2 of 3 members in one Save request removes exactly those 2, and the removal survives a later sync', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const list = await getListByDay('wednesday');
  const section = (await sectionsForList(list.id))[0];

  const ids = [];
  for (const name of ['Batch A', 'Batch B', 'Batch C']) {
    const { lastInsertRowid } = await db
      .prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)')
      .run(`Wed ${name}`, `Wed ${name}`, 'parent');
    ids.push(lastInsertRowid);
    await db.prepare("INSERT INTO volunteer_members (volunteer_list_id, section_id, member_id, rank) VALUES (?, ?, ?, 'sometimes')").run(list.id, section.id, lastInsertRowid);
  }
  const [keepId, removeId1, removeId2] = ids;

  await t.test('one Save submission with 2 removeMemberIds removes exactly those two', async () => {
    const res = await request(app)
      .post(`/admin/volunteers/wednesday/teams/${section.id}/hour-label`)
      .set('Cookie', cookie)
      .type('form')
      .send({ label: 'Hour 1', removeMemberIds: [String(removeId1), String(removeId2)], _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Removed 2 member\(s\)/);

    const remaining = (await db.prepare('SELECT member_id FROM volunteer_members WHERE volunteer_list_id = ? AND section_id = ?').all(list.id, section.id)).map((r) => r.member_id);
    assert.deepEqual(remaining.sort(), [keepId].sort());
  });

  await t.test('an unrelated later sync does not bring the removed members back', async () => {
    await syncDayMemberRosters('wednesday');
    const remaining = (await db.prepare('SELECT member_id FROM volunteer_members WHERE volunteer_list_id = ? AND section_id = ?').all(list.id, section.id)).map((r) => r.member_id);
    assert.ok(!remaining.includes(removeId1) && !remaining.includes(removeId2), 'removed members must not silently reappear after a later sync');
  });
});

test('Setup/Cleanup Teams card markup: the trash icon is a plain button wired to a hidden, form-linked checkbox', async () => {
  const { cookie } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Batch Remove Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Batch Remove Cleanup Member', 'Batch Remove Cleanup Member', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.match(res.text, new RegExp(`<input type="checkbox" name="removeMemberIds" value="${memberId}" form="team-edit-form-${teamId}" hidden data-member-remove-checkbox`));
  assert.doesNotMatch(res.text, new RegExp(`action="/admin/setup/monday/teams/${teamId}/remove-member/${memberId}"`));
  assert.match(res.text, /<script src="\/js\/team-member-remove-toggle\.js"><\/script>/);
});

test('Setup/Cleanup Teams: removing 2 of 3 members in one Save request (alongside a title change) removes exactly those 2', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Original Batch Team')").run();

  const ids = [];
  for (const name of ['Cleanup A', 'Cleanup B', 'Cleanup C']) {
    const { lastInsertRowid } = await db
      .prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)')
      .run(name, name, 'parent');
    ids.push(lastInsertRowid);
    await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, lastInsertRowid);
  }
  const [keepId, removeId1, removeId2] = ids;

  const res = await request(app)
    .post(`/admin/setup/monday/teams/${teamId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ title: 'Renamed Batch Team', leaderId: '', removeMemberIds: [String(removeId1), String(removeId2)], _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Removed 2 member\(s\)/);

  const teamRow = await db.prepare('SELECT title FROM setup_teams WHERE id = ?').get(teamId);
  assert.equal(teamRow.title, 'Renamed Batch Team', 'the title edit in the same submission should still have saved');

  const remaining = (await db.prepare('SELECT member_id FROM setup_team_members WHERE team_id = ?').all(teamId)).map((r) => r.member_id);
  assert.deepEqual(remaining.sort(), [keepId].sort());
});

test('Saving with no removeMemberIds at all still works exactly as before (no accidental removals)', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const { lastInsertRowid: teamId } = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'No Removal Team')").run();
  const { lastInsertRowid: memberId } = await db
    .prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Stays Put', 'Stays Put', 'parent')")
    .run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(teamId, memberId);

  const res = await request(app)
    .post(`/admin/setup/monday/teams/${teamId}/edit`)
    .set('Cookie', cookie)
    .type('form')
    .send({ title: 'No Removal Team', leaderId: '', _csrf: csrfToken });
  assert.equal(res.status, 302);
  assert.doesNotMatch(decodeURIComponent(res.headers.location), /Removed/);

  const remaining = await db.prepare('SELECT 1 FROM setup_team_members WHERE team_id = ? AND member_id = ?').get(teamId, memberId);
  assert.ok(remaining, 'the member should still be on the team');
});

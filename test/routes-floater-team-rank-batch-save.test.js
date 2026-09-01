// Real HTTP-level coverage for a real request: "when edit the floater
// list and changing the choose first, sometimes and backup drop down it
// should stay on that screen and not refresh until I click the check
// mark to save the card. I should be able to change several dropdowns
// next to each floater before I click save." Each floater's rank
// <select> used to own its own tiny <form> that auto-submitted (and
// reloaded the page) on every single change - it's now tied to the
// card's shared hour-edit-form via form="..." (same piggyback pattern
// test/routes-team-batched-member-removal.test.js already proved out for
// the trash icon), so any number of pending rank changes ride along with
// one Save submission instead of each causing its own round trip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `floater-rank-batch-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `floater-rank-batch-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpassword123';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
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

test('changing several floaters\' rank dropdowns in one Save submission saves every one of them, in a single request', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const list = await getListByDay('monday');
  const section = (await sectionsForList(list.id))[0];

  const members = [];
  for (const name of ['Rank Batch A', 'Rank Batch B', 'Rank Batch C']) {
    const { lastInsertRowid } = await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run(name, name, 'parent');
    await db.prepare("INSERT INTO volunteer_members (volunteer_list_id, section_id, member_id, rank) VALUES (?, ?, ?, 'sometimes')").run(list.id, section.id, lastInsertRowid);
    members.push(lastInsertRowid);
  }
  const [firstId, backupId, untouchedId] = members;

  const res = await request(app)
    .post(`/admin/volunteers/monday/teams/${section.id}/hour-label`)
    .set('Cookie', cookie)
    .type('form')
    .send({
      label: 'Hour 1',
      [`rank_${firstId}`]: 'first',
      [`rank_${backupId}`]: 'backup',
      _csrf: csrfToken,
    });
  assert.equal(res.status, 302);

  const rows = await db.prepare('SELECT member_id, rank FROM volunteer_members WHERE volunteer_list_id = ? AND section_id = ?').all(list.id, section.id);
  const rankById = Object.fromEntries(rows.map((r) => [r.member_id, r.rank]));
  assert.equal(rankById[firstId], 'first');
  assert.equal(rankById[backupId], 'backup');
  assert.equal(rankById[untouchedId], 'sometimes', 'a member whose dropdown was never touched keeps its existing rank');
});

test('an invalid/tampered rank value is silently ignored, not saved', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const list = await getListByDay('monday');
  const section = (await sectionsForList(list.id))[0];
  const { lastInsertRowid: memberId } = await db.prepare('INSERT INTO members (name, barcode, member_type) VALUES (?, ?, ?)').run('Rank Tamper Test', 'Rank Tamper Test', 'parent');
  await db.prepare("INSERT INTO volunteer_members (volunteer_list_id, section_id, member_id, rank) VALUES (?, ?, ?, 'sometimes')").run(list.id, section.id, memberId);

  const res = await request(app)
    .post(`/admin/volunteers/monday/teams/${section.id}/hour-label`)
    .set('Cookie', cookie)
    .type('form')
    .send({ label: 'Hour 1', [`rank_${memberId}`]: 'not-a-real-rank', _csrf: csrfToken });
  assert.equal(res.status, 302);

  const row = await db.prepare('SELECT rank FROM volunteer_members WHERE volunteer_list_id = ? AND section_id = ? AND member_id = ?').get(list.id, section.id, memberId);
  assert.equal(row.rank, 'sometimes', 'an invalid rank value must not overwrite the existing one');
});

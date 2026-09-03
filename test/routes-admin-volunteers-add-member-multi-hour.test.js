// Coverage for a real request: "when adding floaters to teams it should
// have check boxes with each hour so you can choose multiple and save."
// The Add Member to a Floater Team dialog (views/admin-volunteer-
// teams.ejs) used to offer a single-hour <select> - one Add only ever
// placed a member on one hour. routes/admin-volunteers.js's own /teams/
// add-member now takes sectionIds[] (checkboxes) instead of a single
// sectionId and loops over every one checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-volunteers-add-member-multi-hour-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-volunteers-add-member-multi-hour-test-uploads-${process.pid}`);
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
  return { cookie, csrfToken, page };
}

test('the Add Member dialog offers a checkbox per hour, not a single-hour dropdown', async () => {
  const { page } = await loginAsAdmin();
  const dialogMatch = /<dialog id="add-team-member-dialog"[^]*?<\/dialog>/.exec(page.text);
  assert.ok(dialogMatch, 'expected the Add Member to a Floater Team dialog');
  const dialogHtml = dialogMatch[0];
  assert.doesNotMatch(dialogHtml, /<select name="sectionId"/, 'the old single-hour select should be gone');
  assert.match(dialogHtml, /name="sectionIds\[\]"/);
  assert.match(dialogHtml, /class="checkbox-row"/);
});

test('POST .../teams/add-member with multiple sectionIds checked adds the member to every one of them', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const list = await getListByDay('monday');
  const sections = await sectionsForList(list.id);
  assert.ok(sections.length >= 2, 'need at least 2 hours to test multi-select');

  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Multi Hour Floater', 'multi-hour-floater', 'parent')").run()).lastInsertRowid;

  const res = await request(app)
    .post('/admin/volunteers/monday/teams/add-member')
    .set('Cookie', cookie)
    .type('form')
    .send({
      memberId: String(memberId),
      'sectionIds[]': [String(sections[0].id), String(sections[1].id)],
      _csrf: csrfToken,
    });

  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.location), /Member added to 2 hour\(s\)\./);

  const rows = await db.prepare('SELECT section_id FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? ORDER BY section_id').all(list.id, memberId);
  assert.deepEqual(
    rows.map((r) => r.section_id).sort((a, b) => a - b),
    [sections[0].id, sections[1].id].sort((a, b) => a - b)
  );
});

test('POST .../teams/add-member with no hours checked adds nothing and does not error', async () => {
  const { cookie, csrfToken } = await loginAsAdmin();
  const memberId = (await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('No Hours Floater', 'no-hours-floater', 'parent')").run()).lastInsertRowid;

  const res = await request(app)
    .post('/admin/volunteers/monday/teams/add-member')
    .set('Cookie', cookie)
    .type('form')
    .send({ memberId: String(memberId), _csrf: csrfToken });

  assert.equal(res.status, 302);
  const row = await db.prepare('SELECT 1 AS "ok" FROM volunteer_members WHERE member_id = ?').get(memberId);
  assert.equal(row, undefined);
});

// Coverage for the new Setup/Cleanup Assignments tab (routes/admin-setup.js's
// /setup/:day/assignments* + /setup/:day/dates* + /setup/:day/archive*
// routes, backed by utils/setup.js's date/assignment helpers) - a real
// user request: "setup/cleanup page should have similar tabs and setup to
// floaters tab pages... assignment page will be similar to floaters where
// it shows the list of team members with a dropdown menu next to each
// name suggesting a different task from that team." Mirrors Floater
// Assignments' own date-scoped manage/archive shape (see
// test/routes-admin-volunteers*.test.js for the model this follows), just
// per-member task suggestion instead of per-hour position/room.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `admin-setup-assignments-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `admin-setup-assignments-test-uploads-${process.pid}`);
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
  const page = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
  const csrfToken = /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { cookie, csrfToken };
}

test('GET /admin/setup redirects to Assignments, not Teams, as the first of the 4 tabs', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/setup').set('Cookie', cookie);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/setup\/(monday|wednesday)\/assignments$/);
});

test('Setup/Cleanup Assignments', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Kitchen Crew')").run();
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Kitchen Tasks', ?, 0)").run(team.lastInsertRowid);
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Wipe down counters');
  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Jane Smith', 'assign-jane', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  await t.test('a fresh day with no session dates shows the "add dates" prompt', async () => {
    const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Add session dates above first/);
  });

  await t.test('adding a date makes it the selected date and renders the team card with a task-suggestion dropdown', async () => {
    const res = await request(app)
      .post('/admin/setup/monday/dates/add')
      .set('Cookie', cookie)
      .type('form')
      .send({ dates: '2026-08-24', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Added 1 date/);

    const page = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
    assert.equal(page.status, 200);
    assert.match(page.text, /Kitchen Crew/);
    assert.match(page.text, /Jane Smith/);
    assert.match(page.text, /#1 &mdash; Wipe down counters/);
    assert.doesNotMatch(page.text, /No upcoming session dates/);
  });

  await t.test('setting a member\'s suggested task persists and shows selected on reload', async () => {
    const res = await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', taskItemId: String(item.lastInsertRowid), _csrf: csrfToken });
    assert.equal(res.status, 302);

    const page = await request(app).get('/admin/setup/monday/assignments?date=2026-08-24').set('Cookie', cookie);
    assert.match(page.text, new RegExp(`<option value="${item.lastInsertRowid}" selected>`));

    const row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', member.lastInsertRowid, '2026-08-24');
    assert.equal(row.task_item_id, item.lastInsertRowid);
  });

  await t.test('clearing the suggestion (blank taskItemId) deletes the row rather than storing a null', async () => {
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', taskItemId: '', _csrf: csrfToken });

    const row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', member.lastInsertRowid, '2026-08-24');
    assert.equal(row, undefined, 'clearing a suggestion should delete the row, not leave a null task_item_id');
  });

  await t.test('export.csv reflects the current suggestion for the given date', async () => {
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', taskItemId: String(item.lastInsertRowid), _csrf: csrfToken });

    const res = await request(app).get('/admin/setup/monday/assignments/export.csv?date=2026-08-24').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Kitchen Crew/);
    assert.match(res.text, /Jane Smith/);
    assert.match(res.text, /Wipe down counters/);
  });

  await t.test('a member can be given a SECOND, independent suggested task without disturbing the first', async () => {
    const item2 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)').run(section.lastInsertRowid, 'Take out trash');

    // Re-set slot 1 (cleared by the previous test) so both slots are live at once.
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '1', taskItemId: String(item.lastInsertRowid), _csrf: csrfToken });
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '2', taskItemId: String(item2.lastInsertRowid), _csrf: csrfToken });

    const row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', member.lastInsertRowid, '2026-08-24');
    assert.equal(row.task_item_id, item.lastInsertRowid, 'slot 1 should be untouched by setting slot 2');
    assert.equal(row.task_item_id_2, item2.lastInsertRowid);

    const page = await request(app).get('/admin/setup/monday/assignments?date=2026-08-24').set('Cookie', cookie);
    assert.match(page.text, /#1 &mdash; Wipe down counters/);
    assert.match(page.text, /#2 &mdash; Take out trash/);

    // Clearing slot 1 only nulls that column - the row survives because
    // slot 2 still has a real suggestion.
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '1', taskItemId: '', _csrf: csrfToken });
    const afterClearingOne = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', member.lastInsertRowid, '2026-08-24');
    assert.ok(afterClearingOne, 'the row should survive - slot 2 still has a suggestion');
    assert.equal(afterClearingOne.task_item_id, null);
    assert.equal(afterClearingOne.task_item_id_2, item2.lastInsertRowid);

    // Clearing the LAST remaining slot deletes the row outright, same
    // contract as the single-slot case above.
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '2', taskItemId: '', _csrf: csrfToken });
    const afterClearingBoth = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', member.lastInsertRowid, '2026-08-24');
    assert.equal(afterClearingBoth, undefined, 'clearing the last remaining slot should delete the row');
  });

  await t.test('export.csv includes both suggested-task columns', async () => {
    const item2 = await db.prepare("SELECT id FROM task_list_items WHERE description = 'Take out trash'").get();
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '1', taskItemId: String(item.lastInsertRowid), _csrf: csrfToken });
    await request(app)
      .post(`/admin/setup/monday/assignments/${member.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-08-24', slot: '2', taskItemId: String(item2.id), _csrf: csrfToken });

    const res = await request(app).get('/admin/setup/monday/assignments/export.csv?date=2026-08-24').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /"Suggested Task 1","Suggested Task 2"/);
    assert.match(res.text, /Wipe down counters/);
    assert.match(res.text, /Take out trash/);
  });

  await t.test('removing a date deletes its task assignments too (cascade)', async () => {
    let row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND session_date = ?').get('monday', '2026-08-24');
    assert.ok(row, 'sanity check: assignment should exist before removal');

    const res = await request(app)
      .post('/admin/setup/monday/dates/2026-08-24/remove')
      .set('Cookie', cookie)
      .type('form')
      .send({ _csrf: csrfToken });
    assert.equal(res.status, 302);

    row = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND session_date = ?').get('monday', '2026-08-24');
    assert.equal(row, undefined, 'removing the date should also remove its task assignments');

    const dateRow = await db.prepare('SELECT * FROM setup_dates WHERE day = ? AND session_date = ?').get('monday', '2026-08-24');
    assert.equal(dateRow, undefined);
  });
});

test('Setup/Cleanup Archive', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Archive Crew')").run();
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Archive Tasks', ?, 0)").run(team.lastInsertRowid);
  const item = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Sweep the floor');
  const member = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Archive Parent', 'assign-archive-parent', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, member.lastInsertRowid);

  await t.test('a date in the past never shows up as a <option> in the live Assignments "Choose Date" dropdown', async () => {
    await request(app).post('/admin/setup/monday/dates/add').set('Cookie', cookie).type('form').send({ dates: '2020-01-06', _csrf: csrfToken });
    const res = await request(app).get('/admin/setup/monday/assignments').set('Cookie', cookie);
    const chooseDateSelect = /<select id="assignments-date-select"[^]*?<\/select>/.exec(res.text)[0];
    assert.doesNotMatch(chooseDateSelect, /2020-01-06/, 'a past date must not be offered as something to suggest a task for');
    // It's still listed in the Edit Dates dialog (so it can be removed) -
    // just not offered as a live-assignable date.
    assert.match(res.text, /2020-01-06/);
  });

  await t.test('but it does show up on the Archive tab\'s date list', async () => {
    const res = await request(app).get('/admin/setup/monday/archive').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /data-view-setup-archive-date="2020-01-06"/);
  });

  await t.test('the archive view-fragment renders that date\'s cards read-only (no editable dropdown)', async () => {
    await db.prepare('INSERT INTO setup_task_assignments (day, member_id, session_date, task_item_id) VALUES (?, ?, ?, ?)').run(
      'monday',
      member.lastInsertRowid,
      '2020-01-06',
      item.lastInsertRowid
    );
    const res = await request(app).get('/admin/setup/monday/archive/2020-01-06/view-fragment').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /Archive Crew/);
    assert.match(res.text, /Archive Parent/);
    assert.match(res.text, /Sweep the floor/);
    assert.doesNotMatch(res.text, /<select/, 'the archive fragment is read-only - no editable <select>');
  });

  await t.test('the archive print page and CSV export both work for a real archived date', async () => {
    const printRes = await request(app).get('/admin/setup/monday/archive/2020-01-06/print').set('Cookie', cookie);
    assert.equal(printRes.status, 200);
    assert.match(printRes.text, /Sweep the floor/);

    const csvRes = await request(app).get('/admin/setup/monday/archive/2020-01-06/export.csv').set('Cookie', cookie);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.text, /Sweep the floor/);
  });

  await t.test('a date that was never added 404s on every archive sub-route', async () => {
    assert.equal((await request(app).get('/admin/setup/monday/archive/2019-01-01/view-fragment').set('Cookie', cookie)).status, 404);
    assert.equal((await request(app).get('/admin/setup/monday/archive/2019-01-01/print').set('Cookie', cookie)).status, 404);
    assert.equal((await request(app).get('/admin/setup/monday/archive/2019-01-01/export.csv').set('Cookie', cookie)).status, 404);
  });
});

test('Setup/Cleanup Assignments: mutual exclusion + batch card save', async (t) => {
  const { cookie, csrfToken } = await loginAsAdmin();

  const team = await db.prepare("INSERT INTO setup_teams (day, title) VALUES ('monday', 'Exclusion Crew')").run();
  const section = await db.prepare("INSERT INTO task_list_sections (day, title, team_id, position) VALUES ('monday', 'Exclusion Tasks', ?, 0)").run(team.lastInsertRowid);
  const item1 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 0)').run(section.lastInsertRowid, 'Vacuum');
  const item2 = await db.prepare('INSERT INTO task_list_items (section_id, description, position) VALUES (?, ?, 1)').run(section.lastInsertRowid, 'Mop');
  const alice = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Alice Exclusion', 'exclusion-alice', 'parent')").run();
  const bob = await db.prepare("INSERT INTO members (name, barcode, member_type) VALUES ('Bob Exclusion', 'exclusion-bob', 'parent')").run();
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, alice.lastInsertRowid);
  await db.prepare('INSERT INTO setup_team_members (team_id, member_id) VALUES (?, ?)').run(team.lastInsertRowid, bob.lastInsertRowid);
  await request(app).post('/admin/setup/monday/dates/add').set('Cookie', cookie).type('form').send({ dates: '2026-09-14', _csrf: csrfToken });

  await t.test('a task already assigned to one member no longer appears as an option for another member on the same team', async () => {
    await request(app)
      .post(`/admin/setup/monday/assignments/${alice.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-09-14', slot: '1', taskItemId: String(item1.lastInsertRowid), _csrf: csrfToken });

    const page = await request(app).get('/admin/setup/monday/assignments?date=2026-09-14').set('Cookie', cookie);
    assert.equal(page.status, 200);
    // Alice's own slot 1 still shows her current pick (Vacuum).
    const aliceSlot1 = new RegExp(`name="task_1_${alice.lastInsertRowid}"[^]*?</select>`).exec(page.text)[0];
    assert.match(aliceSlot1, /#1 &mdash; Vacuum/);
    // Bob's slot 1 dropdown must NOT offer Vacuum - it's taken.
    const bobSlot1 = new RegExp(`name="task_1_${bob.lastInsertRowid}"[^]*?</select>`).exec(page.text)[0];
    assert.doesNotMatch(bobSlot1, /Vacuum/, 'a task already assigned to Alice must not be offered to Bob');
    assert.match(bobSlot1, /Mop/, 'Mop is still unassigned, so it should still be offered');
  });

  await t.test('a member\'s own slot 1 and slot 2 can\'t both offer the same task they already hold in the other slot', async () => {
    await request(app)
      .post(`/admin/setup/monday/assignments/${alice.lastInsertRowid}/task`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '2026-09-14', slot: '2', taskItemId: String(item2.lastInsertRowid), _csrf: csrfToken });

    const page = await request(app).get('/admin/setup/monday/assignments?date=2026-09-14').set('Cookie', cookie);
    const aliceSlot1 = new RegExp(`name="task_1_${alice.lastInsertRowid}"[^]*?</select>`).exec(page.text)[0];
    assert.doesNotMatch(aliceSlot1, /Mop/, 'slot 1 must not also offer whatever Alice already holds in slot 2');
    const aliceSlot2 = new RegExp(`name="task_2_${alice.lastInsertRowid}"[^]*?</select>`).exec(page.text)[0];
    assert.doesNotMatch(aliceSlot2, /Vacuum/, 'slot 2 must not also offer whatever Alice already holds in slot 1');
  });

  await t.test('the Task 1/Task 2 column headers replace the old "Suggested Task" labels', async () => {
    const page = await request(app).get('/admin/setup/monday/assignments?date=2026-09-14').set('Cookie', cookie);
    assert.match(page.text, /<th>Task 1<\/th><th>Task 2<\/th>/);
    assert.doesNotMatch(page.text, /Suggested Task/);
  });

  await t.test('saving a whole card at once (the Edit/Save flow\'s own route) updates every member on that team together', async () => {
    const res = await request(app)
      .post(`/admin/setup/monday/assignments/team/${team.lastInsertRowid}/save`)
      .set('Cookie', cookie)
      .type('form')
      .send({
        date: '2026-09-14',
        [`task_1_${alice.lastInsertRowid}`]: '',
        [`task_2_${alice.lastInsertRowid}`]: String(item1.lastInsertRowid),
        [`task_1_${bob.lastInsertRowid}`]: String(item2.lastInsertRowid),
        _csrf: csrfToken,
      });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Assignments saved/);

    const aliceRow = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', alice.lastInsertRowid, '2026-09-14');
    assert.equal(aliceRow.task_item_id, null, 'Alice\'s slot 1 was submitted blank, clearing her previous Vacuum pick');
    assert.equal(aliceRow.task_item_id_2, item1.lastInsertRowid, 'Alice\'s slot 2 now holds Vacuum (freed up since her own slot 1 was cleared)');

    const bobRow = await db.prepare('SELECT * FROM setup_task_assignments WHERE day = ? AND member_id = ? AND session_date = ?').get('monday', bob.lastInsertRowid, '2026-09-14');
    assert.equal(bobRow.task_item_id, item2.lastInsertRowid, 'Bob now holds Mop');
  });

  await t.test('a batch save with no date redirects with an error instead of a bare crash', async () => {
    const res = await request(app)
      .post(`/admin/setup/monday/assignments/team/${team.lastInsertRowid}/save`)
      .set('Cookie', cookie)
      .type('form')
      .send({ date: '', _csrf: csrfToken });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.location), /Pick a date first/);
  });
});

test('Setup/Cleanup Teams page gained an Archive button and the shared 4-tab bar', async () => {
  const { cookie } = await loginAsAdmin();
  const res = await request(app).get('/admin/setup/monday/manage').set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/admin\/setup\/monday\/archive">Archive</);
  assert.match(res.text, /Setup\/Cleanup Assignments/);
  assert.match(res.text, /Setup\/Cleanup Teams/);
  assert.match(res.text, /Task List/);
});
